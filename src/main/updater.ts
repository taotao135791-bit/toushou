import { execFile, spawn, spawnSync } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import https from 'node:https'
import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import YAML from 'yaml'
import { IPC_CHANNELS } from '../shared/constants'
import { UpdaterStatus } from '../shared/types'
import { proxyFetchFor } from './integrations/tiktok/proxyFetch'

/**
 * Auto-update via electron-updater (GitHub Releases provider, configured in
 * electron-builder.json). Packaged builds only; in dev every action reports
 * { status: 'dev' }. Downloads are manual (autoDownload = false) and every
 * status change is broadcast to all windows.
 */

let currentStatus: UpdaterStatus = { status: 'idle' }
let initialized = false
let checkInFlight: Promise<UpdaterStatus> | null = null
let activeCheck: { manual: boolean; result: UpdaterStatus | null; downloadGeneration: number } | null = null
let downloadGeneration = 0
let installRequested = false
let useUnsignedMacUpdater = false
let pendingUpdate: { version: string; url: string; fileName: string } | null = null
let downloadedUnsignedUpdate: { version: string; extractedApp: string; extractDir: string } | null = null

const INITIAL_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function setStatus(status: UpdaterStatus): void {
  currentStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.UPDATER_STATUS, status)
    }
  }
}

export function getUpdaterStatus(): UpdaterStatus {
  return currentStatus
}

function hasUpdate(status: UpdaterStatus): boolean {
  return status.status === 'available' || status.status === 'downloading' || status.status === 'progress' || status.status === 'downloaded'
}

/** Background checks announce releases, never their transient work/errors. */
function setCheckStatus(status: UpdaterStatus): void {
  if (activeCheck) activeCheck.result = status
  // A check started before the user downloaded must not replace that flow,
  // including its failure, when a late check event arrives.
  if (activeCheck && activeCheck.downloadGeneration !== downloadGeneration) return
  if (currentStatus.status === 'downloading' || currentStatus.status === 'progress' || currentStatus.status === 'downloaded') return
  if (status.status === 'available') {
    if (currentStatus.status === 'available' && compareVersions(status.version, currentStatus.version) <= 0) return
    setStatus(status)
  } else if (activeCheck?.manual && !hasUpdate(currentStatus)) {
    setStatus(status)
  }
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/code signature at url|did not pass validation/i.test(message)) {
    return '当前安装包未配置受信任的代码签名，请先安装最新版本；后续版本可直接在应用内更新。'
  }
  // A release tag can be published minutes before its ~1GB of artifacts
  // finish uploading; during that window latest.yml 404s and the raw
  // HttpError reads like a broken updater. Say what is actually happening.
  if (/Cannot find latest\.yml/i.test(message)) {
    return '新版本刚发布，更新文件还在上传中，请几分钟后再检查。'
  }
  return message.length > 240 ? `${message.slice(0, 237)}…` : message
}

function isAdHocMacBuild(): boolean {
  if (process.platform !== 'darwin') return false
  const result = spawnSync('codesign', ['-dvvv', process.execPath], { encoding: 'utf8' })
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return /Signature=adhoc|TeamIdentifier=not set/i.test(details)
}

function httpsRedirect(url: string, location: string | undefined, label: string): string | null {
  if (!location) return null
  const next = new URL(location, url)
  if (next.protocol !== 'https:') throw new Error(`${label}链接不安全`)
  return next.toString()
}

function requestText(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('更新服务器重定向次数过多'))
    if (new URL(url).protocol !== 'https:') return reject(new Error('更新服务器链接不安全'))
    const request = https.get(
      url,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Toushou-Updater' } },
      (response) => {
        let location: string | null
        try {
          location = httpsRedirect(url, response.headers.location, '更新服务器')
        } catch (err) {
          response.resume()
          reject(err)
          return
        }
        if (location) {
          response.resume()
          return requestText(new URL(location, url).toString(), redirects + 1).then(resolve, reject)
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`更新服务器返回 HTTP ${response.statusCode ?? 0}`))
            return
          }
          resolve(body)
        })
      }
    )
    request.on('error', reject)
    request.setTimeout(20_000, () => request.destroy(new Error('更新检查超时，请稍后重试。')))
  })
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/i, '').split(/[.+-]/).map((part) => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  }
  return 0
}

function currentMacArtifactName(): string {
  return `TouShou-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`
}

async function unsignedMacCheck(): Promise<UpdaterStatus> {
  setCheckStatus({ status: 'checking' })
  try {
    // Read the public electron-builder channel file instead of the GitHub
    // Releases API. The API is rate-limited for unauthenticated desktop
    // clients, which made valid old installs report HTTP 403 and blocked
    // in-app updates.
    const metadata = YAML.parse(
      await requestText('https://github.com/taotao135791-bit/toushou/releases/latest/download/latest-mac.yml')
    ) as { version?: unknown; files?: unknown }
    const version = typeof metadata.version === 'string' ? metadata.version : ''
    const assetName = currentMacArtifactName()
    const files = Array.isArray(metadata.files) ? metadata.files : []
    const asset = files.find(
      (item): item is { url?: unknown } =>
        Boolean(item && typeof item === 'object' && (item as { url?: unknown }).url === assetName)
    )
    const downloadUrl = `https://github.com/taotao135791-bit/toushou/releases/latest/download/${encodeURIComponent(assetName)}`
    if (!version || compareVersions(version, app.getVersion()) <= 0) {
      if (!hasUpdate(currentStatus)) pendingUpdate = null
      setCheckStatus({ status: 'none' })
    } else if (!asset) {
      throw new Error(`当前架构没有可用的 ${assetName} 更新包`)
    } else {
      if (currentStatus.status !== 'available' || compareVersions(version, currentStatus.version) >= 0) {
        pendingUpdate = { version, url: downloadUrl, fileName: assetName }
      }
      setCheckStatus({ status: 'available', version })
    }
  } catch (err) {
    setCheckStatus({ status: 'error', message: errorMessage(err), operation: 'check' })
  }
  return currentStatus
}

function downloadFile(url: string, destination: string, onProgress: (percent: number) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('更新下载重定向次数过多'))
    if (new URL(url).protocol !== 'https:') return reject(new Error('更新下载链接不安全'))
    const request = https.get(url, { headers: { 'User-Agent': 'Toushou-Updater' } }, (response) => {
      let location: string | null
      try {
        location = httpsRedirect(url, response.headers.location, '更新下载')
      } catch (err) {
        response.resume()
        reject(err)
        return
      }
      if (location) {
        response.resume()
        return downloadFile(new URL(location, url).toString(), destination, onProgress, redirects + 1).then(resolve, reject)
      }
      if (response.statusCode !== 200) {
        response.resume()
        return reject(new Error(`更新下载返回 HTTP ${response.statusCode ?? 0}`))
      }
      const total = Number(response.headers['content-length'] ?? 0)
      let received = 0
      const file = createWriteStream(destination)
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total > 0) onProgress(Math.round((received / total) * 1000) / 10)
      })
      response.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
      response.on('error', reject)
    })
    request.on('error', reject)
  })
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000 }, (err) => (err ? reject(err) : resolve()))
  })
}

async function unsignedMacDownload(): Promise<UpdaterStatus> {
  if (!pendingUpdate) return updaterCheck()
  const update = pendingUpdate
  const root = path.join(app.getPath('temp'), `toushou-update-${update.version}-${Date.now()}`)
  const zipPath = path.join(root, update.fileName)
  const extractDir = path.join(root, 'extracted')
  setStatus({ status: 'downloading' })
  try {
    mkdirSync(extractDir, { recursive: true })
    await downloadFile(update.url, zipPath, (percent) => setStatus({ status: 'progress', percent }))
    await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir])
    const extractedApp = path.join(extractDir, '投手.app')
    if (!existsSync(path.join(extractedApp, 'Contents', 'Info.plist'))) {
      throw new Error('更新包中没有找到有效的应用程序')
    }
    downloadedUnsignedUpdate = { version: update.version, extractedApp, extractDir }
    setStatus({ status: 'downloaded', version: update.version })
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    setStatus({ status: 'error', message: errorMessage(err), operation: 'download' })
  }
  return currentStatus
}

function scheduleUnsignedMacInstall(): void {
  if (!downloadedUnsignedUpdate) {
    setStatus({ status: 'error', message: '更新包尚未下载完成，请重试。', operation: 'install' })
    return
  }
  // process.resourcesPath points to `<App>.app/Contents/Resources`; move up
  // two levels to the bundle root. Moving up only once resolves to
  // `<App>.app/Contents`, which made every valid macOS install look invalid
  // when the user tried to install an unsigned in-app update.
  const currentApp = path.resolve(process.resourcesPath, '../..')
  if (path.basename(currentApp) !== '投手.app' || !existsSync(path.join(currentApp, 'Contents', 'Info.plist'))) {
    setStatus({ status: 'error', message: '当前应用安装位置无效，请使用最新安装包重新安装。', operation: 'install' })
    return
  }
  const scriptPath = path.join(app.getPath('temp'), `toushou-install-${Date.now()}.sh`)
  const script = [
    '#!/bin/sh',
    'set -eu',
    'old_app="$1"',
    'new_app="$2"',
    'parent_pid="$3"',
    'backup="$old_app.backup.$$"',
    'i=0',
    'while kill -0 "$parent_pid" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 120 ] && exit 1; sleep 1; done',
    '[ -d "$new_app" ] || exit 1',
    'mv "$old_app" "$backup"',
    'if mv "$new_app" "$old_app"; then',
    '  rm -rf "$backup"',
    '  open "$old_app"',
    'else',
    '  mv "$backup" "$old_app"',
    '  exit 1',
    'fi',
    'rm -f "$0"',
    ''
  ].join('\n')
  writeFileSync(scriptPath, script, { mode: 0o700 })
  chmodSync(scriptPath, 0o700)
  const child = spawn('/bin/sh', [scriptPath, currentApp, downloadedUnsignedUpdate.extractedApp, String(process.pid)], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  app.quit()
}

/** Wire autoUpdater events and schedule the initial check 10s after launch. */
export function initUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true

  useUnsignedMacUpdater = isAdHocMacBuild()
  autoUpdater.autoDownload = false
  // Installing is an explicit in-app action. Do not silently replace the app
  // when the user quits after a download.
  autoUpdater.autoInstallOnAppQuit = false
  if (!useUnsignedMacUpdater) {
    autoUpdater.on('checking-for-update', () => setCheckStatus({ status: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      setCheckStatus({ status: 'available', version: info.version })
    )
    autoUpdater.on('update-not-available', () => setCheckStatus({ status: 'none' }))
    autoUpdater.on('download-progress', (progress) =>
      setStatus({ status: 'progress', percent: Math.round(progress.percent * 10) / 10 })
    )
    autoUpdater.on('update-downloaded', (info) =>
      setStatus({ status: 'downloaded', version: info.version })
    )
    autoUpdater.on('error', (err) => {
      if (installRequested) {
        installRequested = false
        setStatus({ status: 'error', message: errorMessage(err), operation: 'install' })
      } else if (activeCheck) {
        setCheckStatus({ status: 'error', message: errorMessage(err), operation: 'check' })
      } else if (currentStatus.status === 'downloading' || currentStatus.status === 'progress') {
        setStatus({ status: 'error', message: errorMessage(err), operation: 'download' })
      }
    })
  }

  setTimeout(() => void updaterCheck(false), INITIAL_CHECK_DELAY_MS)
  setInterval(() => {
    // A long-lived app should discover releases without requiring a restart,
    // while an active download/install flow must never be interrupted.
    if (currentStatus.status !== 'downloading' &&
        currentStatus.status !== 'progress' &&
        currentStatus.status !== 'downloaded') {
      void updaterCheck(false)
    }
  }, CHECK_INTERVAL_MS)
}

/** IPC calls are manual; launch/periodic checks opt into silent operation. */
export async function updaterCheck(manual = true): Promise<UpdaterStatus> {
  if (!app.isPackaged) return { status: 'dev' }
  if (currentStatus.status === 'downloading' ||
      currentStatus.status === 'progress' ||
      currentStatus.status === 'downloaded') return currentStatus
  if (checkInFlight) {
    if (manual && activeCheck) {
      activeCheck.manual = true
      if (!activeCheck.result || activeCheck.result.status === 'checking') setCheckStatus({ status: 'checking' })
    }
    return checkInFlight
  }

  const check = { manual, result: null as UpdaterStatus | null, downloadGeneration }
  activeCheck = check
  checkInFlight = (async () => {
    if (useUnsignedMacUpdater) {
      await unsignedMacCheck()
      if (check.downloadGeneration !== downloadGeneration) return currentStatus
      if (hasUpdate(currentStatus) && check.result?.status !== 'error') return currentStatus
      return check.result ?? currentStatus
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // A single check can die on a transient network blip (VPN route change
      // surfaces as net::ERR_NETWORK_CHANGED, plus the usual timeouts). One
      // delayed retry before the error reaches the banner — a flapping route
      // must not read as "update failed".
      const transient = /ERR_NETWORK_CHANGED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed/i.test(
        err instanceof Error ? err.message : String(err)
      )
      if (!transient) {
        setCheckStatus({ status: 'error', message: errorMessage(err), operation: 'check' })
      } else {
        try {
          await new Promise((resolve) => setTimeout(resolve, 3000))
          await autoUpdater.checkForUpdates()
        } catch (retryErr) {
          setCheckStatus({ status: 'error', message: errorMessage(retryErr), operation: 'check' })
        }
      }
    }
    if (check.downloadGeneration !== downloadGeneration) return currentStatus
    if (hasUpdate(currentStatus) && check.result?.status !== 'error') return currentStatus
    return check.result ?? currentStatus
  })()
  try {
    return await checkInFlight
  } finally {
    checkInFlight = null
    activeCheck = null
  }
}

/** Download the available update; progress arrives as updater:status events. */
export async function updaterDownload(): Promise<UpdaterStatus> {
  if (!app.isPackaged) return { status: 'dev' }
  if (currentStatus.status === 'downloading' || currentStatus.status === 'progress' || currentStatus.status === 'downloaded') return currentStatus
  downloadGeneration += 1
  if (useUnsignedMacUpdater) return unsignedMacDownload()
  // Windows routes through the resilient downloader (stall watchdog, Range
  // resume, direct/proxy rotation, SHA512 verify); electron-updater's own
  // executor is the in-function fallback when every attempt fails.
  if (process.platform === 'win32') return windowsDownload()
  setStatus({ status: 'downloading' })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    setStatus({ status: 'error', message: errorMessage(err), operation: 'download' })
  }
  return currentStatus
}

export function updaterQuitAndInstall(): void {
  if (!app.isPackaged) return
  installRequested = true
  try {
    if (useUnsignedMacUpdater) scheduleUnsignedMacInstall()
    else if (process.platform === 'win32' && winInstallerPath) windowsInstall()
    else autoUpdater.quitAndInstall()
  } catch (err) {
    installRequested = false
    setStatus({ status: 'error', message: errorMessage(err), operation: 'install' })
  }
}

/**
 * Open the GitHub releases page in the browser — the manual fallback when
 * in-app update can't run (e.g. unsigned builds, where Squirrel.Mac refuses
 * to install).
 */
export async function updaterOpenReleasePage(): Promise<void> {
  await shell.openExternal('https://github.com/taotao135791-bit/toushou/releases/latest')
}

// ---------------------------------------------------------------------------
// Windows resilient download — the electron-updater executor has no stall
// detection: on a connection that silently stops delivering bytes (a VPN
// tunnel dying mid-transfer is the classic case) the progress bar freezes
// forever. This downloader follows the user's configured network (environment
// /system proxy — the same resolution as every other integration; it never
// switches routes, nodes, or proxies on the user's behalf), resumes from the
// partial file with Range requests, aborts a stalled attempt and retries the
// SAME network with resume, verifies SHA512 before install is allowed, and
// falls back to electron-updater's own download when every attempt fails.
// ---------------------------------------------------------------------------

const UPDATE_BASE = 'https://github.com/taotao135791-bit/toushou/releases/latest/download'
const WIN_INSTALLER_ATTEMPTS = 8
const WIN_STALL_TIMEOUT_MS = 30_000
const WIN_WATCHDOG_TICK_MS = 5_000

interface WinManifest {
  version: string
  url: string
  fileName: string
  sha512: string
}

interface WinFetchResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body?: { cancel?(): unknown } | null
}

export type WinFetcher = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<WinFetchResponse>

export interface ResumableDownloadOptions {
  /**
   * ONE fetcher over the user's configured network (environment/system proxy
   * as resolved for every other integration). This module NEVER switches
   * routes or nodes on the user's behalf: a stalled attempt is aborted and
   * retried over the SAME network with Range resume, and repeated failure
   * surfaces an actionable error instead.
   */
  fetcher: WinFetcher
  /** No bytes for this long = the route stalled (tests use a small value). */
  stallTimeoutMs?: number
  /** Expected total size when known (progress denominator before Range metadata). */
  totalSize?: number
  /** Called with 0-100. */
  onProgress?: (percent: number) => void
  /** Poll: return false to abort the whole loop (the caller went away). */
  shouldContinue?: () => boolean
  sleep?: (ms: number) => Promise<void>
}

/**
 * Download `url` to `destination` resuming from any partial file. Every
 * attempt: resume from the current file size (Range) through the next fetcher
 * in rotation; a stall (no bytes for WIN_STALL_TIMEOUT_MS) aborts the attempt.
 * A server that ignores Range answers 200 — the partial file is discarded and
 * the download restarts cleanly.
 */
export async function downloadResumable(url: string, destination: string, options: ResumableDownloadOptions): Promise<void> {
  const { fetcher, onProgress = () => {}, shouldContinue } = options
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: Error = new Error('下载重试次数用尽')
  for (let attempt = 0; attempt < WIN_INSTALLER_ATTEMPTS; attempt++) {
    if (shouldContinue && !shouldContinue()) throw new Error('下载已取消')
    let received = existsSync(destination) ? statSync(destination).size : 0
    const controller = new AbortController()
    const headers: Record<string, string> = { 'User-Agent': 'Toushou-Updater' }
    if (received > 0) headers.Range = `bytes=${received}-`
    let lastBytes = received
    let lastAt = Date.now()
    const stallTimeoutMs = options.stallTimeoutMs ?? WIN_STALL_TIMEOUT_MS
    const watchdog = setInterval(() => {
      if (received === lastBytes && Date.now() - lastAt > stallTimeoutMs) controller.abort()
      // Reset only on movement; a stalled line keeps failing this check.
      if (received !== lastBytes) lastAt = Date.now()
    }, Math.max(50, Math.min(WIN_WATCHDOG_TICK_MS, Math.floor(stallTimeoutMs / 4))))
    // A fetcher that ignores the abort signal must not hang the attempt: the
    // abort itself rejects this race and the loop moves on.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('下载停滞，已切换线路')), { once: true })
    })
    try {
      const response = await Promise.race([
        fetcher(url, { headers, signal: controller.signal }),
        aborted
      ])
      if (response.status === 416 && received > 0) {
        // Range start beyond EOF: the partial file is already complete.
        clearInterval(watchdog)
        onProgress(100)
        return
      }
      if (response.status !== 200 && response.status !== 206) {
        response.body?.cancel?.()
        throw new Error(`更新下载返回 HTTP ${response.status}`)
      }
      if (response.status === 200 && received > 0) {
        // The server ignored Range — discard the partial file.
        rmSync(destination, { force: true })
        received = 0
      }
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      const total = contentLength > 0 ? contentLength + received : options.totalSize ?? 0
      if (!response.body) throw new Error('下载响应没有内容')
      const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      const file = createWriteStream(destination, received > 0 ? { flags: 'r+', start: received } : undefined)
      const pumped = Promise.race([
        aborted,
        new Promise<void>((resolve, reject) => {
          stream.on('data', (chunk: Buffer) => {
            received += chunk.length
            lastBytes = received
            lastAt = Date.now()
            if (total > 0) onProgress(Math.round((received / total) * 1000) / 10)
          })
          stream.on('error', reject)
          file.on('error', reject)
          file.on('finish', () => resolve())
          stream.pipe(file)
        })
      ])
      await pumped
      clearInterval(watchdog)
      // A clean 206 with FEWER bytes than requested is an incomplete transfer,
      // not a success — the next attempt resumes from the new file size.
      if (total > 0 && received < total) throw new Error('下载不完整，继续重试')
      onProgress(100)
      return
    } catch (error) {
      clearInterval(watchdog)
      lastError = error instanceof Error ? error : new Error(String(error))
      await sleep(2_000)
    }
  }
  throw lastError
}

export function verifySha512File(destination: string, expectedBase64: string): boolean {
  const hash = createHash('sha512')
  hash.update(readFileSync(destination))
  return hash.digest('base64') === expectedBase64
}

async function fetchWindowsManifest(): Promise<WinManifest> {
  // Prefer the user's configured network (environment/system proxy) for the
  // tiny manifest too — on machines whose only route to github.com is that
  // proxy, a raw-direct fetch would fail and silently degrade every update
  // to the un-resumable fallback. Direct stays as the fallback route.
  let text: string
  try {
    const fetcher = await proxyFetchFor(`${UPDATE_BASE}/latest.yml`, 'updater')
    const response = await fetcher(`${UPDATE_BASE}/latest.yml`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Toushou-Updater' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    text = await response.text()
  } catch {
    text = await requestText(`${UPDATE_BASE}/latest.yml`)
  }
  const metadata = YAML.parse(
    text
  ) as { version?: unknown; files?: Array<{ url?: unknown; sha512?: unknown }> }
  const version = typeof metadata.version === 'string' ? metadata.version : ''
  const files = Array.isArray(metadata.files) ? metadata.files : []
  const asset = files.find((item): item is { url: string; sha512: string } => {
    const entry = item && typeof item === 'object' ? (item as { url?: unknown; sha512?: unknown }) : null
    return !!entry && typeof entry.url === 'string' && entry.url.endsWith('.exe') && typeof entry.sha512 === 'string' && entry.sha512.length > 0
  })
  if (!version || !asset) throw new Error('更新清单里缺少 Windows 安装包信息')
  return { version, url: `${UPDATE_BASE}/${encodeURIComponent(asset.url)}`, fileName: asset.url, sha512: asset.sha512 }
}

let winInstallerPath: string | null = null
let winDownloadActive = false

/** Windows branch of updaterDownload: resilient download + SHA512 verify. */
async function windowsDownload(): Promise<UpdaterStatus> {
  if (winDownloadActive) return currentStatus
  winDownloadActive = true
  setStatus({ status: 'downloading' })
  const dir = path.join(app.getPath('temp'), 'toushou-update')
  const destination = path.join(dir, 'TouShou-x64.exe')
  try {
    mkdirSync(dir, { recursive: true })
    const manifest = await fetchWindowsManifest()
    if (compareVersions(manifest.version, app.getVersion()) <= 0) {
      setStatus({ status: 'none' })
      return currentStatus
    }
    const fetcher: WinFetcher = async (url, init) => (await proxyFetchFor(url, 'updater'))(url, init) as unknown as Promise<WinFetchResponse>
    await downloadResumable(manifest.url, destination, {
      fetcher,
      onProgress: (percent) => {
        if (winDownloadActive) setStatus({ status: 'progress', percent })
      }
    })
    if (!verifySha512File(destination, manifest.sha512)) {
      rmSync(destination, { force: true })
      throw new Error('安装包校验失败（下载不完整或被篡改），已删除并请重试。')
    }
    winInstallerPath = destination
    setStatus({ status: 'downloaded', version: manifest.version })
  } catch (err) {
    winDownloadActive = false
    const message = err instanceof Error ? err.message : String(err)
    // Custom path exhausted: electron-updater's chunked downloader is the
    // second net. Its progress events arrive on the same handler chain.
    try {
      await autoUpdater.downloadUpdate()
      return currentStatus
    } catch (fallbackErr) {
      void fallbackErr
      setStatus({ status: 'error', message: `${message}（备用下载也失败）`, operation: 'download' })
    }
  }
  winDownloadActive = false
  return currentStatus
}

/** Windows branch of updaterQuitAndInstall: silent NSIS install. */
function windowsInstall(): void {
  if (!winInstallerPath || !existsSync(winInstallerPath)) {
    setStatus({ status: 'error', message: '更新包尚未下载完成，请重试。', operation: 'install' })
    return
  }
  const child = spawn(winInstallerPath, ['/S'], { detached: true, stdio: 'ignore' })
  child.unref()
  app.quit()
}
