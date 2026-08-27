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

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 10_000)
}

/** Manual check; the returned status reflects the outcome. */
export async function updaterCheck(): Promise<UpdaterStatus> {
  if (!app.isPackaged) return { status: 'dev' }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setStatus({ status: 'error', message: errorMessage(err) })
  }
  return currentStatus
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
  await shell.openExternal('https://github.com/taotao135791-bit/omp-gui/releases/latest')
}
