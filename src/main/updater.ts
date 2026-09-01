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
  return err instanceof Error ? err.message : String(err)
}

/** Wire autoUpdater events and schedule the initial check 10s after launch. */
export function initUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true

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
