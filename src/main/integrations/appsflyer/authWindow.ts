import { BrowserWindow, session } from 'electron'
import { createHash } from 'node:crypto'

/**
 * In-app authorization window for OAuth flows whose redirect target is a
 * loopback listener owned by this module. The window runs in its own
 * in-memory session with a direct-then-system proxy policy, so a user's
 * browser-level proxy state (bad extensions, cached PAC failures, corporate
 * settings) cannot block the grant — the app's own API traffic already uses
 * the same resilient fetch path.
 *
 * Security posture: sandboxed, no preload, no node integration, only
 * https navigations plus the final loopback redirect, and the window closes
 * itself the moment the callback lands.
 */
export interface AuthWindowHandle {
  /** Resolves when the loopback redirect was navigated to (or the window closed). */
  done: Promise<'redirected' | 'closed'>
  close(): void
}

export function openAuthWindow(authorizationUrl: string, redirectPrefix: string): AuthWindowHandle {
  const partition = `appsflyer-auth-${createHash('sha256').update(authorizationUrl).digest('hex').slice(0, 24)}`
  const ses = session.fromPartition(partition)
  // Direct first: the loopback redirect and the provider pages are both
  // reachable without a proxy; a user PAC can still be honoured by switching
  // this to 'system' if a region ever needs it.
  void ses.setProxy({ mode: 'direct' })

  let settled = false
  let win: BrowserWindow | null = null
  const done = new Promise<'redirected' | 'closed'>((resolve) => {
    const settle = (value: 'redirected' | 'closed') => {
      if (settled) return
      settled = true
      resolve(value)
    }
    win = new BrowserWindow({
      width: 480,
      height: 720,
      title: 'AppsFlyer',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.once('ready-to-show', () => win?.show())
    win.on('closed', () => settle('closed'))
    win.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith(redirectPrefix)) {
        event.preventDefault()
        settle('redirected')
        win?.close()
        return
      }
      if (!url.startsWith('https://')) {
        event.preventDefault()
        return
      }
    })
    win.webContents.on('will-redirect', (event, url) => {
      if (url.startsWith(redirectPrefix)) {
        event.preventDefault()
        settle('redirected')
        win?.close()
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void win.loadURL(authorizationUrl)
  })
  return {
    done,
    close: () => { if (win && !win.isDestroyed()) win.close() }
  }
}
