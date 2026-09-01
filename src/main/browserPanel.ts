import { BrowserWindow, WebContentsView, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { BrowserNavigateAction, BrowserPanelBounds, BrowserPanelState } from '../shared/types'
import { safeBrowserPanelUrl, safeExternalUrl } from './navigation'

/**
 * One in-app browser panel per window: a Main-owned WebContentsView layered
 * over the renderer at bounds the renderer mirrors from a placeholder
 * element. The view is deliberately weaker than the main renderer — no
 * preload, sandboxed, in-memory session partition (third-party cookies never
 * reach disk) — and it can load only http(s) URLs that pass
 * safeBrowserPanelUrl. Popups are denied and rerouted to the system browser
 * through the same validation as Markdown links.
 *
 * The view survives hidePanel() so navigation history and page state persist
 * across route changes; it is destroyed with its window.
 */

/** Panels keyed by their owner window's id. */
const panels = new Map<number, WebContentsView>()
/** Owner windows already wired for 'closed' cleanup. */
const cleanupWired = new Set<number>()

export const BROWSER_PANEL_BOUNDS_LIMIT = 100_000

/**
 * Bounds cross IPC as `unknown`; accept exactly four finite, non-negative,
 * bounded numbers. Anything else is rejected rather than clamped — a clamped
 * rectangle would silently disagree with the placeholder the user sees.
 */
export function sanitizeBrowserPanelBounds(value: unknown): BrowserPanelBounds | null {
  if (!value || typeof value !== 'object') return null
  const b = value as Record<string, unknown>
  const nums = [b.x, b.y, b.width, b.height]
  if (
    !nums.every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= BROWSER_PANEL_BOUNDS_LIMIT
    )
  ) {
    return null
  }
  return { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
}

function panelState(view: WebContentsView): BrowserPanelState {
  return {
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    loading: view.webContents.isLoading(),
    canGoBack: view.webContents.navigationHistory.canGoBack(),
    canGoForward: view.webContents.navigationHistory.canGoForward()
  }
}

function sendState(win: BrowserWindow, view: WebContentsView): void {
  if (win.isDestroyed() || view.webContents.isDestroyed()) return
  win.webContents.send(IPC_CHANNELS.BROWSER_STATE, panelState(view))
}

function createPanel(win: BrowserWindow): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // In-memory partition: browsing state never persists to disk.
      partition: 'ompgui-browser-panel'
    }
  })
  const { webContents } = view

  // The panel is a web surface, not an app window: popups are never created.
  // Safe web URLs go to the system browser (same policy as Markdown links).
  webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalUrl(url)
    if (safeUrl) {
      void shell.openExternal(safeUrl).catch(() => undefined)
    }
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (!safeBrowserPanelUrl(url)) event.preventDefault()
  })

  const emit = () => sendState(win, view)
  webContents.on('did-navigate', emit)
  webContents.on('did-navigate-in-page', emit)
  webContents.on('did-start-loading', emit)
  webContents.on('did-stop-loading', emit)
  webContents.on('page-title-updated', emit)

  if (!cleanupWired.has(win.id)) {
    cleanupWired.add(win.id)
    win.once('closed', () => {
      cleanupWired.delete(win.id)
      const panel = panels.get(win.id)
      panels.delete(win.id)
      if (panel && !panel.webContents.isDestroyed()) panel.webContents.close()
    })
  }

  panels.set(win.id, view)
  return view
}

/**
 * Attach the panel to the window and optionally load a URL. An invalid URL
 * is rejected without showing or navigating the panel.
 */
export function showBrowserPanel(
  win: BrowserWindow,
  bounds: BrowserPanelBounds,
  url?: string
): { ok: boolean; error?: string } {
  if (win.isDestroyed()) return { ok: false, error: 'window-gone' }
  const view = panels.get(win.id) ?? createPanel(win)
  if (url !== undefined) {
    const safeUrl = safeBrowserPanelUrl(url)
    if (!safeUrl) return { ok: false, error: 'invalid-url' }
    void view.webContents.loadURL(safeUrl).catch(() => sendState(win, view))
  }
  // Re-adding an already attached view is harmless; setBounds keeps the
  // panel aligned with the renderer placeholder.
  win.contentView.addChildView(view)
  view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) })
  sendState(win, view)
  return { ok: true }
}

/** Detach the panel but keep the view alive (history/session survives). */
export function hideBrowserPanel(win: BrowserWindow): { ok: boolean } {
  if (win.isDestroyed()) return { ok: false }
  const view = panels.get(win.id)
  if (view) win.contentView.removeChildView(view)
  return { ok: true }
}

/** Move the panel to follow its renderer placeholder. */
export function setBrowserPanelBounds(win: BrowserWindow, bounds: BrowserPanelBounds): { ok: boolean } {
  if (win.isDestroyed()) return { ok: false }
  const view = panels.get(win.id)
  if (!view) return { ok: false }
  view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) })
  return { ok: true }
}

/** Toolbar navigation; 'go' requires a valid http(s) URL. */
export function navigateBrowserPanel(
  win: BrowserWindow,
  action: BrowserNavigateAction,
  url?: string
): { ok: boolean; error?: string } {
  if (win.isDestroyed()) return { ok: false, error: 'window-gone' }
  const view = panels.get(win.id)
  if (!view) return { ok: false, error: 'no-panel' }
  const { webContents } = view
  switch (action) {
    case 'back':
      if (webContents.navigationHistory.canGoBack()) webContents.navigationHistory.goBack()
      return { ok: true }
    case 'forward':
      if (webContents.navigationHistory.canGoForward()) webContents.navigationHistory.goForward()
      return { ok: true }
    case 'reload':
      webContents.reload()
      return { ok: true }
    case 'go': {
      const safeUrl = safeBrowserPanelUrl(url)
      if (!safeUrl) return { ok: false, error: 'invalid-url' }
      void webContents.loadURL(safeUrl).catch(() => sendState(win, view))
      return { ok: true }
    }
  }
}
