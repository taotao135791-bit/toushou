import { execFile, spawn, spawnSync } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC_CHANNELS } from '../shared/constants'
import { UpdaterStatus } from '../shared/types'

/**
 * Auto-update via electron-updater (GitHub Releases provider, configured in
 * electron-builder.json). Packaged builds only; in dev every action reports
 * { status: 'dev' }. Downloads are manual (autoDownload = false) and every
 * status change is broadcast to all windows.
 */

let currentStatus: UpdaterStatus = { status: 'idle' }
let initialized = false
let checkInFlight: Promise<UpdaterStatus> | null = null
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

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/code signature at url|did not pass validation/i.test(message)) {
    return '当前安装包未配置受信任的代码签名，请先安装最新版本；后续版本可直接在应用内更新。'
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

function requestJson(url: string, redirects = 0): Promise<unknown> {
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
          return requestJson(new URL(location, url).toString(), redirects + 1).then(resolve, reject)
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`更新服务器返回 HTTP ${response.statusCode ?? 0}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('更新信息格式无效'))
          }
        })
      }
    )
    request.on('error', reject)
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
  setStatus({ status: 'checking' })
  try {
    const release = (await requestJson('https://api.github.com/repos/taotao135791-bit/toushou/releases/latest')) as {
      tag_name?: unknown
      assets?: Array<{ name?: unknown; browser_download_url?: unknown }>
    }
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/i, '') : ''
    const assetName = currentMacArtifactName()
    const asset = release.assets?.find(
      (item) => item.name === assetName && typeof item.browser_download_url === 'string'
    )
    if (!version || compareVersions(version, app.getVersion()) <= 0) {
      pendingUpdate = null
      setStatus({ status: 'none' })
    } else if (!asset || typeof asset.browser_download_url !== 'string') {
      throw new Error(`当前架构没有可用的 ${assetName} 更新包`)
    } else {
      pendingUpdate = { version, url: asset.browser_download_url, fileName: assetName }
      setStatus({ status: 'available', version })
    }
  } catch (err) {
    setStatus({ status: 'error', message: errorMessage(err) })
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
  if (!pendingUpdate) return unsignedMacCheck()
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
    setStatus({ status: 'error', message: errorMessage(err) })
  }
  return currentStatus
}

function scheduleUnsignedMacInstall(): void {
  if (!downloadedUnsignedUpdate) {
    setStatus({ status: 'error', message: '更新包尚未下载完成，请重试。' })
    return
  }
  // process.resourcesPath points to `<App>.app/Contents/Resources`; move up
  // two levels to the bundle root. Moving up only once resolves to
  // `<App>.app/Contents`, which made every valid macOS install look invalid
  // when the user tried to install an unsigned in-app update.
  const currentApp = path.resolve(process.resourcesPath, '../..')
  if (path.basename(currentApp) !== '投手.app' || !existsSync(path.join(currentApp, 'Contents', 'Info.plist'))) {
    setStatus({ status: 'error', message: '当前应用安装位置无效，请使用最新安装包重新安装。' })
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

  if (useUnsignedMacUpdater) {
    setTimeout(() => void updaterCheck(), INITIAL_CHECK_DELAY_MS)
    setInterval(() => {
      if (currentStatus.status !== 'downloading' && currentStatus.status !== 'progress' && currentStatus.status !== 'downloaded') {
        void updaterCheck()
      }
    }, CHECK_INTERVAL_MS)
    return
  }

  autoUpdater.autoDownload = false
  // Installing is an explicit in-app action. Do not silently replace the app
  // when the user quits after a download.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => setStatus({ status: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    setStatus({ status: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () => setStatus({ status: 'none' }))
  autoUpdater.on('download-progress', (progress) =>
    setStatus({ status: 'progress', percent: Math.round(progress.percent * 10) / 10 })
  )
  autoUpdater.on('update-downloaded', (info) =>
    setStatus({ status: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (err) => setStatus({ status: 'error', message: errorMessage(err) }))

  setTimeout(() => void updaterCheck(), INITIAL_CHECK_DELAY_MS)
  setInterval(() => {
    // A long-lived app should discover releases without requiring a restart,
    // while an active download/install flow must never be interrupted.
    if (currentStatus.status !== 'downloading' &&
        currentStatus.status !== 'progress' &&
        currentStatus.status !== 'downloaded') {
      void updaterCheck()
    }
  }, CHECK_INTERVAL_MS)
}

/** Manual check; the returned status reflects the outcome. */
export async function updaterCheck(): Promise<UpdaterStatus> {
  if (!app.isPackaged) return { status: 'dev' }
  if (currentStatus.status === 'downloading' ||
      currentStatus.status === 'progress' ||
      currentStatus.status === 'downloaded') return currentStatus
  if (checkInFlight) return checkInFlight

  if (useUnsignedMacUpdater) {
    checkInFlight = unsignedMacCheck()
    try {
      return await checkInFlight
    } finally {
      checkInFlight = null
    }
  }

  checkInFlight = (async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      setStatus({ status: 'error', message: errorMessage(err) })
    }
    return currentStatus
  })()
  try {
    return await checkInFlight
  } finally {
    checkInFlight = null
  }
}

/** Download the available update; progress arrives as updater:status events. */
export async function updaterDownload(): Promise<UpdaterStatus> {
  if (!app.isPackaged) return { status: 'dev' }
  if (useUnsignedMacUpdater) return unsignedMacDownload()
  setStatus({ status: 'downloading' })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    setStatus({ status: 'error', message: errorMessage(err) })
  }
  return currentStatus
}

export function updaterQuitAndInstall(): void {
  if (!app.isPackaged) return
  if (useUnsignedMacUpdater) {
    scheduleUnsignedMacInstall()
    return
  }
  autoUpdater.quitAndInstall()
}

/**
 * Open the GitHub releases page in the browser — the manual fallback when
 * in-app update can't run (e.g. unsigned builds, where Squirrel.Mac refuses
 * to install).
 */
export async function updaterOpenReleasePage(): Promise<void> {
  await shell.openExternal('https://github.com/taotao135791-bit/toushou/releases/latest')
}
