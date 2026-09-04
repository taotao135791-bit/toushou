import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { BrowserWindow } from 'electron'
import { getActiveBrowserPanel, isBrowserPanelVisible } from './browserPanel'
import { safeBrowserPanelUrl } from './navigation'
import { IPC_CHANNELS } from '../shared/constants'

/**
 * Browser-use bridge: lets runtime extension tools drive the in-app browser
 * panel (navigate / read DOM / simulate input / screenshot) through a
 * loopback-only HTTP endpoint with a session-token.
 *
 * Threat model and rules:
 * - The endpoint binds 127.0.0.1 only and every request must carry the token
 *   handed to the runtime via env — same delivery pattern as the approval
 *   extension's config. No other host can reach it.
 * - Actions are a closed whitelist. The wire NEVER carries script source:
 *   the GUI maps each action to its own extraction/interaction code, so a
 *   compromised extension cannot execute arbitrary JS in the panel.
 * - Payloads are size-capped; results are truncated before they cross back.
 * - The panel stays the user's surface: it must already be open (or the
 *   agent must navigate first, which opens it through the normal
 *   PANEL_OPEN flow the renderer already handles).
 */

const MAX_BODY_BYTES = 64 * 1024
const MAX_TEXT_CHARS = 20_000
const MAX_ELEMENTS = 200
const MAX_SCREENSHOTS_KEPT = 12
const LOAD_TIMEOUT_MS = 20_000
const MAX_WAIT_MS = 5_000
const SUBMIT_NAVIGATION_TIMEOUT_MS = 1_000

export const BROWSER_USE_ENV_KEY = 'TOUSHOU_BROWSER_USE'

/**
 * Session admission for one bridge request. `navigate` is always allowed (it
 * visibly (re)opens the panel and TAKES ownership); every other action must
 * come from the owning session while the panel is attached — the user sees
 * everything the agent does, and parallel sessions cannot silently mutate a
 * page another session is working on.
 */
export function gateBrowserUseRequest(
  action: BrowserUseAction,
  sessionId: string,
  owner: string | null,
  panelVisible: boolean
): 'panel-hidden' | 'panel-owned-by-another-session' | null {
  if (action === 'navigate') return null
  if (!panelVisible) return 'panel-hidden'
  if (owner !== null && owner !== sessionId) return 'panel-owned-by-another-session'
  return null
}

/** One entry per whitelisted action; validated in `parseBrowserUseRequest`. */
export type BrowserUseAction =
  | 'navigate'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'scroll'
  | 'screenshot'
  | 'back'
  | 'forward'
  | 'wait'

export interface BrowserUseRequest {
  action: BrowserUseAction
  url?: string
  ref?: number
  text?: string
  submit?: boolean
  direction?: 'up' | 'down'
  amount?: number
  ms?: number
}

export type BrowserUseResult =
  | { ok: true; url?: string; title?: string; text?: string; elements?: Array<Record<string, unknown>>; imagePath?: string }
  | { ok: false; error: string }

const ACTION_NAMES = new Set<string>([
  'navigate',
  'snapshot',
  'click',
  'type',
  'scroll',
  'screenshot',
  'back',
  'forward',
  'wait'
])

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.slice(0, max)
}

/** Pure request validator — unit-tested; the server refuses anything else. */
export function parseBrowserUseRequest(raw: unknown): BrowserUseRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const action = body.action
  if (typeof action !== 'string' || !ACTION_NAMES.has(action)) return null

  switch (action as BrowserUseAction) {
    case 'navigate': {
      const url = boundedString(body.url, 2_048)
      return url ? { action: 'navigate', url } : null
    }
    case 'snapshot':
      return { action: 'snapshot' }
    case 'click': {
      const ref = body.ref
      if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1 || ref > MAX_ELEMENTS) return null
      return { action: 'click', ref }
    }
    case 'type': {
      const ref = body.ref
      if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1 || ref > MAX_ELEMENTS) return null
      const text = boundedString(body.text, 4_000)
      if (text === undefined) return null
      return { action: 'type', ref, text, submit: body.submit === true }
    }
    case 'scroll': {
      const direction = body.direction === 'up' ? 'up' : body.direction === 'down' ? 'down' : null
      if (!direction) return null
      const amount = typeof body.amount === 'number' && Number.isFinite(body.amount)
        ? Math.min(Math.max(Math.round(body.amount), 40), 4_000)
        : 600
      return { action: 'scroll', direction, amount }
    }
    case 'screenshot':
      return { action: 'screenshot' }
    case 'back':
      return { action: 'back' }
    case 'forward':
      return { action: 'forward' }
    case 'wait': {
      const ms = typeof body.ms === 'number' && Number.isFinite(body.ms)
        ? Math.min(Math.max(Math.round(body.ms), 0), MAX_WAIT_MS)
        : 1_000
      return { action: 'wait', ms }
    }
  }
}

/**
 * DOM snapshot script. Tags interactive elements with stable data-ts-ref
 * attributes so later click/type actions resolve the exact element. Runs in
 * the page; returns plain JSON only.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]'
  const elements = []
  let n = 0
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= ${MAX_ELEMENTS}) break
    if (!visible(el)) continue
    n += 1
    el.setAttribute('data-ts-ref', String(n))
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
    const tag = el.tagName.toLowerCase()
    const type = tag === 'input' ? (el.getAttribute('type') || 'text') : undefined
    elements.push({ ref: n, tag, type, text, value: typeof el.value === 'string' ? el.value.slice(0, 120) : undefined })
  }
  const root = document.querySelector('main') || document.querySelector('article') || document.body
  const text = (root && root.innerText ? root.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${MAX_TEXT_CHARS})
  return { url: location.href, title: document.title, text, elements }
})()`

function exec<T>(script: string): Promise<T> {
  const panel = getActiveBrowserPanel()
  if (!panel) return Promise.reject(new Error('panel-not-open'))
  if (!isBrowserPanelVisible()) return Promise.reject(new Error('panel-hidden'))
  return panel.webContents.executeJavaScript(script, true) as Promise<T>
}

function currentPage(requireVisible = true): { url: string; title: string } {
  const panel = getActiveBrowserPanel()
  if (!panel) throw new Error('panel-not-open')
  if (requireVisible && !isBrowserPanelVisible()) throw new Error('panel-hidden')
  return { url: panel.webContents.getURL(), title: panel.webContents.getTitle() }
}

function waitForLoad(timeoutMs = LOAD_TIMEOUT_MS, requireVisible = true): Promise<void> {
  const panel = getActiveBrowserPanel()
  if (!panel) return Promise.reject(new Error('panel-not-open'))
  if (requireVisible && !isBrowserPanelVisible()) return Promise.reject(new Error('panel-hidden'))
  const wc = panel.webContents
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve() // still resolve: snapshot will see whatever loaded
    }, timeoutMs)
    const done = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timer)
      wc.off('did-stop-loading', done)
      wc.off('did-fail-load', done)
    }
    wc.on('did-stop-loading', done)
    wc.on('did-fail-load', done)
  })
}

/**
 * Wait for a navigation even when Chromium has not flipped isLoading yet.
 * Synthetic Enter/requestSubmit can schedule navigation on a later turn of
 * the event loop; checking isLoading once is therefore racy.
 */
function waitForNavigation(previousUrl: string, timeoutMs: number): Promise<void> {
  const panel = getActiveBrowserPanel()
  if (!panel) return Promise.reject(new Error('panel-not-open'))
  if (!isBrowserPanelVisible()) return Promise.reject(new Error('panel-hidden'))
  const wc = panel.webContents
  if (wc.getURL() !== previousUrl) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)
    const done = () => {
      cleanup()
      resolve()
    }
    const onNavigation = () => {
      if (wc.getURL() !== previousUrl) done()
    }
    const cleanup = () => {
      clearTimeout(timer)
      wc.off('did-navigate', onNavigation)
      wc.off('did-navigate-in-page', onNavigation)
      wc.off('did-stop-loading', onNavigation)
    }
    wc.on('did-navigate', onNavigation)
    wc.on('did-navigate-in-page', onNavigation)
    wc.on('did-stop-loading', onNavigation)
    queueMicrotask(onNavigation)
  })
}

async function openPanelWithUrl(url: string): Promise<void> {
  // Reuse the renderer-driven flow so the panel lands with proper bounds and
  // the user sees exactly what the agent is about to operate on.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.PANEL_OPEN, { panel: 'browser', url })
    }
  }
  // Give the renderer a moment to mount the panel before loading checks.
  await new Promise((r) => setTimeout(r, 300))
}

async function runAction(req: BrowserUseRequest): Promise<BrowserUseResult> {
  switch (req.action) {
    case 'navigate': {
      const safeUrl = safeBrowserPanelUrl(req.url as string)
      if (!safeUrl) return { ok: false, error: 'invalid-url' }
      await openPanelWithUrl(safeUrl)
      // The renderer drives the visible attach; Main also loads directly so
      // navigation is real even while the attach transition is in flight.
      const existing = getActiveBrowserPanel()
      if (existing) {
        if (existing.webContents.getURL() !== safeUrl) {
          await existing.webContents.loadURL(safeUrl).catch(() => undefined)
        }
      }
      // Navigation is the one action allowed to reopen a hidden panel. The
      // renderer may attach it just after this request returns (for example
      // while its panel transition is still running), so loading itself must
      // not depend on visibility.
      await waitForLoad(LOAD_TIMEOUT_MS, false)
      const page = currentPage(false)
      return { ok: true, url: page.url, title: page.title }
    }
    case 'snapshot': {
      const snap = await exec<{
        url: string
        title: string
        text: string
        elements: Array<Record<string, unknown>>
      }>(SNAPSHOT_SCRIPT)
      return {
        ok: true,
        url: snap.url,
        title: snap.title,
        text: snap.text.slice(0, MAX_TEXT_CHARS),
        elements: (snap.elements ?? []).slice(0, MAX_ELEMENTS)
      }
    }
    case 'click': {
      const center = await exec<{ x: number; y: number } | null>(`(() => {
        const el = document.querySelector('[data-ts-ref="${req.ref}"]')
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (!center) return { ok: false, error: 'ref-not-found' }
      if (!isBrowserPanelVisible()) return { ok: false, error: 'panel-hidden' }
      const panel = getActiveBrowserPanel()
      if (!panel) return { ok: false, error: 'panel-not-open' }
      const wc = panel.webContents
      wc.sendInputEvent({ type: 'mouseMove', x: center.x, y: center.y })
      wc.sendInputEvent({ type: 'mouseDown', x: center.x, y: center.y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: center.x, y: center.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 250))
      await waitForLoad(8_000)
      const page = currentPage()
      return { ok: true, url: page.url, title: page.title }
    }
    case 'type': {
      const focus = await exec<boolean>(`(() => {
        const el = document.querySelector('[data-ts-ref="${req.ref}"]')
        if (!el) return false
        el.scrollIntoView({ block: 'center' })
        if (typeof el.focus === 'function') el.focus()
        if (typeof el.select === 'function') { try { el.select() } catch {} }
        return true
      })()`)
      if (!focus) return { ok: false, error: 'ref-not-found' }
      const panel = getActiveBrowserPanel()
      if (!panel) return { ok: false, error: 'panel-not-open' }
      const wc = panel.webContents
      if (!isBrowserPanelVisible()) return { ok: false, error: 'panel-hidden' }
      const before = wc.getURL()
      // insertText is the reliable programmatic typing primitive (char input
      // events alone often do not commit text into the focused editor).
      wc.insertText(req.text as string)
      await new Promise((r) => setTimeout(r, 150))
      if (req.submit) {
        const firstSubmitWait = waitForNavigation(before, SUBMIT_NAVIGATION_TIMEOUT_MS)
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        await firstSubmitWait
        if (wc.getURL() === before) {
          // Chromium ignores synthetic Enter for implicit form submission on
          // some pages; requestSubmit() is the standards equivalent (still
          // our own whitelisted script, never extension-provided source).
          const fallbackSubmitWait = waitForNavigation(before, 8_000)
          await exec(`(() => {
            const el = document.querySelector('[data-ts-ref="${req.ref}"]')
            const form = el && (el.form || (el.tagName === 'FORM' ? el : null))
            if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
            return true
          })()`)
          await fallbackSubmitWait
        }
      }
      const page = currentPage()
      return { ok: true, url: page.url, title: page.title }
    }
    case 'scroll': {
      await exec(`window.scrollBy({ top: ${req.direction === 'up' ? '-' : ''}${req.amount} })`)
      await new Promise((r) => setTimeout(r, 150))
      const page = currentPage()
      return { ok: true, url: page.url, title: page.title }
    }
    case 'screenshot': {
      const panel = getActiveBrowserPanel()
      if (!panel) return { ok: false, error: 'panel-not-open' }
      if (!isBrowserPanelVisible()) return { ok: false, error: 'panel-hidden' }
      const image = await panel.webContents.capturePage()
      if (image.isEmpty()) return { ok: false, error: 'empty-capture' }
      const dir = path.join(app.getPath('userData'), 'browser-use')
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `shot-${Date.now()}.png`)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(file, image.toPNG())
      // Keep the directory bounded; failures here never fail the action.
      try {
        const stale = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort()
        for (const name of stale.slice(0, Math.max(0, stale.length - MAX_SCREENSHOTS_KEPT))) {
          await unlink(path.join(dir, name))
        }
      } catch {
        // ignore cleanup errors
      }
      return { ok: true, imagePath: file }
    }
    case 'back':
    case 'forward': {
      await exec(`history.${req.action}()`)
      await waitForLoad(8_000)
      const page = currentPage()
      return { ok: true, url: page.url, title: page.title }
    }
    case 'wait': {
      await new Promise((r) => setTimeout(r, req.ms))
      const page = currentPage()
      return { ok: true, url: page.url, title: page.title }
    }
  }
}

let bridgePort: number | null = null
let bridgeReady: Promise<void> | null = null
/** Per-session credentials: token → the GUI session id it was minted for. */
const sessionTokens = new Map<string, string>()
/** Session id that currently owns the panel (last navigate). */
let panelOwner: string | null = null
/** Browser actions must be serialized so ownership cannot change mid-action. */
let browserActionQueue = Promise.resolve()

function withBrowserActionLock<T>(task: () => Promise<T>): Promise<T> {
  const run = browserActionQueue.then(task, task)
  browserActionQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Start the loopback server at app startup; safe to call more than once. */
export function initBrowserUseBridge(): Promise<void> {
  if (bridgePort !== null) return Promise.resolve()
  if (bridgeReady) return bridgeReady
  bridgeReady = new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => void handle(req, res))
    const fail = (error: Error) => {
      bridgePort = null
      bridgeReady = null
      reject(error)
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        bridgePort = address.port
        resolve()
      } else {
        fail(new Error('browser-use bridge did not receive a listening address'))
      }
    })
  })
  return bridgeReady
}

/**
 * Env additions for ONE GUI-spawned session. The token rides in the URL
 * path, so the single env value is address, credential, and session
 * identity at once — parallel sessions cannot act as each other.
 */
export function browserUseEnv(sessionId: string): Record<string, string> {
  if (bridgePort === null) return {}
  const token = randomBytes(24).toString('hex')
  sessionTokens.set(token, sessionId)
  return { [BROWSER_USE_ENV_KEY]: `http://127.0.0.1:${bridgePort}/${token}` }
}

/** Test/internals hook: current ownership state. */
export function browserUseOwner(): string | null {
  return panelOwner
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const unauthorized = (): void => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
  }
  if (req.method !== 'POST') return unauthorized()
  const token = (req.url ?? '').replace(/^\//, '')
  const sessionId = sessionTokens.get(token)
  if (!sessionId) return unauthorized()

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return unauthorized()
    chunks.push(chunk as Buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'bad-json' }))
    return
  }
  const request = parseBrowserUseRequest(parsed)
  if (!request) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'bad-action' }))
    return
  }
  await withBrowserActionLock(async () => {
    const denied = gateBrowserUseRequest(
      request.action,
      sessionId,
      panelOwner,
      isBrowserPanelVisible()
    )
    if (denied) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: false,
          error: denied,
          hint:
            denied === 'panel-hidden'
              ? 'the browser panel is closed; navigate (which visibly reopens it) before acting'
              : 'another session owns the browser panel; navigate to take it over (visible to the user)'
        })
      )
      return
    }
    try {
      const result = await runAction(request)
      if (request.action === 'navigate' && result.ok) {
        panelOwner = sessionId
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'action-failed' })
      )
    }
  })
}

/**
 * Serve a screenshot previously written by the browser_use screenshot action
 * to the renderer as a data URL. The path must be one of Main's own capture
 * files (inside userData/browser-use, .png) — a renderer-supplied arbitrary
 * path is never read.
 */
export async function readBrowserScreenshotData(filePath: unknown): Promise<string | null> {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 512) return null
  const dir = path.join(app.getPath('userData'), 'browser-use')
  const resolved = path.resolve(filePath)
  const relative = path.relative(dir, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  if (!resolved.endsWith('.png')) return null
  try {
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(resolved)
    // Screenshots are bounded by the capture page size; refuse absurd reads.
    if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024) return null
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}
