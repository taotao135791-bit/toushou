import { BrowserWindow, WebContentsView, session } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { BrowserNavigateAction, BrowserPanelBounds, BrowserPanelState } from '../shared/types'
import { safeBrowserPanelUrl } from './navigation'

/**
 * One in-app browser panel per window: a Main-owned WebContentsView layered
 * over the renderer at bounds the renderer mirrors from a placeholder
 * element. The view is deliberately weaker than the main renderer — no
 * preload, sandboxed — and it can load only http(s) URLs that pass
 * safeBrowserPanelUrl. Browsing state lives in a persistent partition so
 * logins (for example a Facebook Business Manager session) survive app
 * restarts; the trade-off is that site cookies are stored on disk under the
 * app's userData. Popups stay in-app on the same partition and the same URL
 * policy, so popup-based flows keep their login state instead of being
 * rerouted to a system browser that holds no session. The session reports a
 * plain Chrome user agent so sites do not fingerprint the embedded panel by
 * its Electron build markers.
 *
 * The view survives hidePanel() so navigation history and page state persist
 * across route changes; it is destroyed with its window.
 */

/** Panels keyed by their owner window's id. */
const panels = new Map<number, WebContentsView>()
/** Window ids whose panel is currently attached (visible) to the window. */
const attachedPanels = new Set<number>()
/** Owner windows already wired for 'closed' cleanup. */
const cleanupWired = new Set<number>()

/** Both renderer attachment and the tool bridge join the same navigation. */
const pendingNavigations = new WeakMap<Electron.WebContents, { key: string; done: Promise<void> }>()

const readingStretchedViews = new WeakSet<WebContentsView>()
const lastVisibleBounds = new WeakMap<WebContentsView, BrowserPanelBounds>()

function parkBrowserPanelOffscreen(win: BrowserWindow, view: WebContentsView): void {
  const [width, height] = win.getContentSize()
  const parkWidth = Math.max(width, 1200)
  const parkHeight = Math.max(height, 3600)
  win.contentView.addChildView(view)
  view.setBounds({ x: width + 100, y: 0, width: parkWidth, height: parkHeight })
}

function navigationKey(raw: string): string {
  const url = new URL(raw)
  url.searchParams.sort()
  return url.toString()
}

export function loadBrowserPanelUrl(
  webContents: Electron.WebContents,
  raw: string,
  refresh = false,
  timeoutMs = 20_000
): Promise<void> {
  const url = safeBrowserPanelUrl(raw)
  if (!url) return Promise.reject(new Error('invalid-url'))
  const key = navigationKey(url)
  const pending = pendingNavigations.get(webContents)
  if (pending?.key === key) return pending.done
  const current = safeBrowserPanelUrl(webContents.getURL())
  if (!refresh && !pending && current && navigationKey(current) === key && !webContents.isLoading()) {
    return Promise.resolve()
  }
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('navigation-timeout'))
      if (pendingNavigations.get(webContents)?.key === key && !webContents.isDestroyed()) webContents.stop()
  }, timeoutMs)
  })
  const done = Promise.race([Promise.resolve().then(() => webContents.loadURL(url)), timeout]).finally(() => {
    clearTimeout(timer)
    if (pendingNavigations.get(webContents)?.done === done) pendingNavigations.delete(webContents)
  })
  pendingNavigations.set(webContents, { key, done })
  return done
}

/**
 * Ads Manager virtualizes campaign rows by viewport height. Electron
 * zoomFactor is not an option: at both 0.5 and 0.75 (reproduced
 * 2026-09-17) the page totals render but the table body stays empty, so
 * the row-count gate refuses forever. Stretch the view to the full window
 * only for the gated reads, then restore the renderer-owned bounds. The
 * restore runs even when the read refuses.
 */
export async function withBrowserReadingViewport<T>(view: WebContentsView, read: () => Promise<T>): Promise<T> {
  // Reentrant: the board refresh wraps reload+report in ONE stretch so the
  // table mounts wide; the nested report call must not restore bounds early.
  if (readingStretchedViews.has(view)) return read()
  readingStretchedViews.add(view)
  const wc = view.webContents
  const owner = BrowserWindow.fromWebContents(wc)
  const windowAlive = Boolean(owner && (typeof owner.isDestroyed !== 'function' || owner.isDestroyed() === false))
  // A visible (attached) panel must keep its placeholder bounds. Moving it
  // off-screen made the workspace go blank AND Ads Manager unmounted every
  // virtualized campaign row — both iOS and AND then failed as unparseable.
  // Hidden background reads still get a tall off-screen layout. Restore
  // using the latest show/hide intent, not the state captured at start.
  let stretched = false
  try {
    if (windowAlive && owner && !attachedPanels.has(owner.id)) {
      const before = view.getBounds()
      parkBrowserPanelOffscreen(owner, view)
      const after = view.getBounds()
      stretched = before.width < 200 || before.height < 200 || before.width !== after.width || before.height !== after.height
    }
    if (stretched) await new Promise((resolve) => setTimeout(resolve, 250))
    return await read()
  } finally {
    try {
      if (!wc.isDestroyed() && windowAlive && owner && (typeof owner.isDestroyed !== 'function' || owner.isDestroyed() === false)) {
        if (attachedPanels.has(owner.id)) {
          const latest = lastVisibleBounds.get(view)
          if (latest) view.setBounds(latest)
        } else {
          try {
            parkBrowserPanelOffscreen(owner, view)
          } catch {
            // Restore must not leak the stretch flag if parking fails.
          }
        }
      }
    } finally {
      readingStretchedViews.delete(view)
    }
  }
}

/** In-app popup windows opened by each panel, closed with their owner. */
const panelChildren = new Map<number, Set<BrowserWindow>>()

/** Persistent partition: browsing state (cookies, logins) survives restarts. */
export const BROWSER_PANEL_PARTITION = 'persist:ompgui-browser-panel'

/** WebPreferences shared by the panel and its in-app popup windows. */
const PANEL_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  // Ads Manager virtualizes rows by viewport. A background board refresh may
  // use a detached (hidden) view; keep its layout/timers active so the strict
  // parser still sees a real table instead of a throttled empty shell.
  backgroundThrottling: false,
  partition: BROWSER_PANEL_PARTITION
} as const

/**
 * A plain-Chrome user agent for the panel session. Electron's default UA
 * carries app/Electron build tokens that let sites distinguish the embedded
 * panel from an ordinary browser; this keeps the Chromium version honest
 * while dropping the markers.
 */
export function plainChromeUserAgent(platform: string, chromeVersion: string): string {
  const platformToken =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

/** URL + popup policy shared by the panel view and its popup windows. */
function wireGuestPolicy(webContents: Electron.WebContents): void {
  // Popups become in-app windows on the same partition (same login state);
  // non-http(s) targets are denied outright.
  webContents.setWindowOpenHandler(({ url }) => {
    if (!safeBrowserPanelUrl(url)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { webPreferences: { ...PANEL_WEB_PREFERENCES } }
    }
  })
  webContents.on('will-navigate', (event, url) => {
    if (!safeBrowserPanelUrl(url)) event.preventDefault()
  })
}

/**
 * The app is single-window in practice; the browser-use bridge targets the
 * first live panel (same policy as the open_panel broadcast).
 */
export function getActiveBrowserPanel(): WebContentsView | null {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const panel = panels.get(win.id)
    if (panel && !panel.webContents.isDestroyed()) return panel
  }
  return null
}

/**
 * Get or create the persistent panel without attaching it to the window.
 * Internal read-only board refreshes use this as a background surface; the
 * user can later attach the exact same session with showBrowserPanel.
 */
export function ensureBrowserPanel(win: BrowserWindow): WebContentsView | null {
  if (win.isDestroyed()) return null
  const view = panels.get(win.id) ?? createPanel(win)
  if (!attachedPanels.has(win.id) && !readingStretchedViews.has(view)) {
    parkBrowserPanelOffscreen(win, view)
  }
  return view
}

/**
 * True when the panel is attached (visible) in its window. Browser-use
 * refuses to operate a detached panel: the user must see what the agent
 * drives. A navigate takes the panel through the PANEL_OPEN flow, which
 * attaches it again.
 */
export function isBrowserPanelVisible(): boolean {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (attachedPanels.has(win.id)) {
      const panel = panels.get(win.id)
      return Boolean(panel && !panel.webContents.isDestroyed())
    }
  }
  return false
}

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
  // Session-level UA covers popup windows too, which never pass through
  // createPanel.
  session
    .fromPartition(BROWSER_PANEL_PARTITION)
    .setUserAgent(plainChromeUserAgent(process.platform, process.versions.chrome))
  const view = new WebContentsView({
    webPreferences: { ...PANEL_WEB_PREFERENCES }
  })
  const { webContents } = view

  wireGuestPolicy(webContents)
  // window.open popups become real windows on the same partition; they get
  // the same guards and are closed together with their owner window.
  webContents.on('did-create-window', (child) => {
    let children = panelChildren.get(win.id)
    if (!children) {
      children = new Set()
      panelChildren.set(win.id, children)
    }
    children.add(child)
    child.once('closed', () => children?.delete(child))
    wireGuestPolicy(child.webContents)
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
      attachedPanels.delete(win.id)
      for (const child of panelChildren.get(win.id) ?? []) {
        if (!child.isDestroyed()) child.close()
      }
      panelChildren.delete(win.id)
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
    void loadBrowserPanelUrl(view.webContents, safeUrl).catch(() => sendState(win, view))
  }
  // Re-adding an already attached view is harmless; setBounds keeps the
  // panel aligned with the renderer placeholder.
  win.contentView.addChildView(view)
  attachedPanels.add(win.id)
  const next = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }
  lastVisibleBounds.set(view, next)
  if (!readingStretchedViews.has(view)) view.setBounds(next)
  sendState(win, view)
  return { ok: true }
}

/** Detach the panel but keep the view alive (history/session survives). */
export function hideBrowserPanel(win: BrowserWindow): { ok: boolean } {
  if (win.isDestroyed()) return { ok: false }
  const view = panels.get(win.id)
  if (view) parkBrowserPanelOffscreen(win, view)
  attachedPanels.delete(win.id)
  return { ok: true }
}

/** Move the panel to follow its renderer placeholder. */
export function setBrowserPanelBounds(win: BrowserWindow, bounds: BrowserPanelBounds): { ok: boolean } {
  if (win.isDestroyed()) return { ok: false }
  const view = panels.get(win.id)
  if (!view) return { ok: false }
  // Renderer ResizeObserver must not yank the view back onto the
  // placeholder while a board read has it stretched off-screen.
  // A hidden panel stays parked off-screen; late placeholder updates
  // (including 0×0 unmount rects) must not collapse Ads Manager.
  const next = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }
  lastVisibleBounds.set(view, next)
  if (readingStretchedViews.has(view) || !attachedPanels.has(win.id)) return { ok: true }
  view.setBounds(next)
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
      void loadBrowserPanelUrl(webContents, safeUrl).catch(() => sendState(win, view))
      return { ok: true }
    }
  }
}
