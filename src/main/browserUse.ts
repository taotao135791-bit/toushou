import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { BrowserWindow } from 'electron'
import { getActiveBrowserPanel, isBrowserPanelVisible, loadBrowserPanelUrl, withBrowserReadingViewport } from './browserPanel'
import { appendFbSnapshot, isFacebookSnapshotUrl } from './fbSnapshots'
import { safeBrowserPanelUrl } from './navigation'
import { IPC_CHANNELS } from '../shared/constants'
import {
  fbAdsReadingsConsistent,
  fbAdsReadingRejection,
  parseFbAdsCampaignsSnapshot
} from '../shared/fbAdsParser'
import type { FbAdsCampaignReading } from '../shared/fbAdsParser'
import { boardReadingRangeDates, buildBoardReadingUrl, fbReadingMatchesWindow, FB_READING_ACCOUNT_TARGETS } from '../shared/fbReading'
import type { FbReadingRange, FbReadingRefreshResult } from '../shared/fbReading'
import { appendFbReading, listFbReadings } from './fbReadings'
import { serializeBoundedJson } from '../shared/boundedJson'

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
 * Session admission for one bridge request. A navigate on an unowned panel is
 * allowed; taking over another session requires an explicit `takeover: true`.
 * Every other action must come from the owning session while the panel is
 * attached — parallel sessions cannot silently mutate a page another session
 * is working on.
 */
export function gateBrowserUseRequest(
  action: BrowserUseAction,
  sessionId: string,
  owner: string | null,
  panelVisible: boolean,
  takeover = false
): 'panel-hidden' | 'panel-owned-by-another-session' | null {
  // history reads the local verified store and never touches the page.
  if (action === 'history') return null
  if (action === 'navigate') {
    if (owner !== null && owner !== sessionId && !takeover) return 'panel-owned-by-another-session'
    return null
  }
  if (!panelVisible) return 'panel-hidden'
  if (owner !== null && owner !== sessionId) return 'panel-owned-by-another-session'
  return null
}

/**
 * Hard read-only boundary for Facebook ad surfaces (2026-09-11 directive):
 * the agent may READ Ads Manager (navigate/snapshot/screenshot/scroll) but
 * can never click or type there, so budget, bid, delivery switches, and
 * publish flows are physically out of reach. Pure — unit-tested alongside
 * gateBrowserUseRequest; runAction enforces it before any input event.
 */
export function isFacebookReadOnlyAction(action: BrowserUseAction, panelUrl: string | null): boolean {
  if (action !== 'click' && action !== 'type') return false
  return panelUrl !== null && isFacebookSnapshotUrl(panelUrl)
}

/** One entry per whitelisted action; validated in `parseBrowserUseRequest`. */
export type BrowserUseAction =
  | 'navigate'
  | 'snapshot'
  | 'report'
  | 'history'
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
  /** Navigation may explicitly transfer the visible panel to this session. */
  takeover?: boolean
  /** Route-preserving panel open (board refresh): do not yank the UI home. */
  keepRoute?: boolean
  accountId?: string
  limit?: number
  ref?: number
  /** Snapshot provenance token returned by browser_snapshot. Required for DOM refs. */
  snapshotId?: string
  text?: string
  submit?: boolean
  direction?: 'up' | 'down'
  amount?: number
  ms?: number
}

export type BrowserUseResult =
  | { ok: true; url?: string; title?: string; text?: string; elements?: Array<Record<string, unknown>>; imagePath?: string; reading?: FbAdsCampaignReading; verified?: boolean; readings?: unknown[]; snapshotId?: string; tabId?: number; observedAt?: number; truncated?: boolean }
  | { ok: false; error: string; text?: string; url?: string; title?: string }

const ACTION_NAMES = new Set<string>([
  'navigate',
  'snapshot',
  'report',
  'history',
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
      return url ? { action: 'navigate', url, ...(body.takeover === true ? { takeover: true } : {}) } : null
    }
    case 'snapshot':
      return { action: 'snapshot' }
    case 'report':
      return { action: 'report' }
    case 'history': {
      const accountId =
        typeof body.accountId === 'string' && /^\d{6,}$/.test(body.accountId) ? body.accountId : undefined
      const limit =
        typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 50
          ? body.limit
          : 10
      return { action: 'history', accountId, limit }
    }
    case 'click': {
      const ref = body.ref
      if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1 || ref > MAX_ELEMENTS) return null
      const snapshotId = boundedString(body.snapshotId, 128)
      return snapshotId ? { action: 'click', ref, snapshotId } : null
    }
    case 'type': {
      const ref = body.ref
      if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1 || ref > MAX_ELEMENTS) return null
      const text = boundedString(body.text, 4_000)
      if (text === undefined) return null
      const snapshotId = boundedString(body.snapshotId, 128)
      return snapshotId ? { action: 'type', ref, text, submit: body.submit === true, snapshotId } : null
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
    // Passwords and credential-like values must never enter the ordinary DOM
    // snapshot, archive, logs, or model context.
    const safeValue = type === 'password' ? undefined : typeof el.value === 'string' ? el.value.slice(0, 120) : undefined
    elements.push({ ref: n, tag, type, text, ...(safeValue !== undefined ? { value: safeValue } : {}) })
  }
  const root = document.querySelector('main') || document.querySelector('article') || document.body
  const text = (root && root.innerText ? root.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${MAX_TEXT_CHARS})
  return { url: location.href, title: document.title, text, elements }
})()`

/** One structured read attempt: raw snapshot plus the strict parse result. */
export interface FbReadOnce<R> {
  url: string
  title: string
  text: string
  reading: R | null
}

/**
 * Scroll script: the main frame AND the roomiest inner scrollable container.
 * Ads Manager tables scroll inside nested divs, not the window, so a
 * window-only scrollBy leaves virtualized rows outside the DOM forever.
 */
export const SCROLL_SCRIPT = (delta: number): string => `(() => {
  const delta = ${delta}
  window.scrollBy({ top: delta })
  let best = null
  let bestRoom = 0
  let seen = 0
  for (const el of document.querySelectorAll('div')) {
    if (seen >= 64) break
    seen += 1
    const style = window.getComputedStyle(el)
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
      const room = el.scrollHeight - el.clientHeight
      if (room > bestRoom) { best = el; bestRoom = room }
    }
  }
  if (best) best.scrollBy({ top: delta })
  return true
})()`

/**
 * Bounded progressive-render retry around the strict FB reading gates.
 *
 * A clean parse alone used to end the wait, but FB renders campaign rows
 * progressively and virtualizes them in and out of the DOM, so a read can
 * parse while rows are still missing (incomplete-view). Re-read until BOTH
 * the first and the post-settle second read parse AND pass the rejection
 * gates, then hand the pair back for the consistency check. Refusal keeps
 * the precise gate code; no data still beats wrong data.
 */
export async function readStableFbReading<R>(
  readOnce: () => Promise<FbReadOnce<R>>,
  rejectionOf: (reading: R) => string | null,
  opts: { delayMs?: number; firstAttempts?: number; secondAttempts?: number; settleDelayMs?: number } = {}
): Promise<
  | { ok: true; first: FbReadOnce<R> & { reading: R }; second: FbReadOnce<R> & { reading: R } }
  | { ok: false; error: string; last: FbReadOnce<R> }
> {
  // Cold loads of Ads Manager (fresh panel after an app restart) can take
  // 30s+ past domcontentloaded before the SPA mounts table rows; 20 × 1.5s
  // covers that without hanging the bridge on a dead page.
  const { delayMs = 1_500, firstAttempts = 20, secondAttempts = 3, settleDelayMs = 700 } = opts
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const stableRead = async (attempts: number): Promise<FbReadOnce<R>> => {
    let last: FbReadOnce<R> | null = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(delayMs)
      last = await readOnce()
      if (fbPageLoadFailure(last) || (last.reading && !rejectionOf(last.reading))) return last
    }
    return last as FbReadOnce<R>
  }

  const first = await stableRead(firstAttempts)
  if (fbPageLoadFailure(first)) return { ok: false, error: 'page-load-failed', last: first }
  if (!first.reading) {
    return { ok: false, error: 'unparseable-page', last: first }
  }
  const firstRejection = rejectionOf(first.reading)
  if (firstRejection) {
    return { ok: false, error: firstRejection, last: first }
  }
  await sleep(settleDelayMs)
  const second = await stableRead(secondAttempts)
  if (fbPageLoadFailure(second)) return { ok: false, error: 'page-load-failed', last: second }
  if (!second.reading) {
    return { ok: false, error: 'unstable-page', last: second }
  }
  const secondRejection = rejectionOf(second.reading)
  if (secondRejection) {
    return { ok: false, error: secondRejection, last: second }
  }
  return {
    ok: true,
    first: first as FbReadOnce<R> & { reading: R },
    second: second as FbReadOnce<R> & { reading: R }
  }
}

function fbPageLoadFailure(page: { url: string; text: string }): boolean {
  return isFacebookSnapshotUrl(page.url) && /(?:错误[：:]\s*组件加载失败|Error:\s*Component failed to load)/i.test(page.text)
}

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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve() // still resolve: snapshot will see whatever loaded
    }, timeoutMs)
    const done = () => {
      cleanup()
      resolve()
    }
    const failed = (_event: unknown, errorCode: number, errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
      if (isMainFrame === false) return
      cleanup()
      reject(new Error(`navigation-failed:${errorCode}:${errorDescription || 'unknown'}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      wc.off('did-stop-loading', done)
      wc.off('did-fail-load', failed)
    }
    wc.on('did-stop-loading', done)
    wc.on('did-fail-load', failed)
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

async function openPanelWithUrl(url: string, keepRoute = false): Promise<void> {
  // Reuse the renderer-driven flow so the panel lands with proper bounds and
  // the user sees exactly what the agent is about to operate on.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(
        IPC_CHANNELS.PANEL_OPEN,
        keepRoute ? { panel: 'browser', url, keepRoute: true } : { panel: 'browser', url }
      )
    }
  }
  // Give the renderer a moment to mount the panel before loading checks.
  await new Promise((r) => setTimeout(r, 300))
}

export async function runAction(req: BrowserUseRequest, sessionId?: string): Promise<BrowserUseResult> {
  if ((req.action === 'click' || req.action === 'type') && req.snapshotId) {
    const latest = sessionId ? latestSnapshotBySession.get(sessionId) : undefined
    if (latest !== req.snapshotId) {
      return { ok: false, error: 'stale-snapshot', text: 'Take a fresh browser_snapshot before using this ref.' }
    }
  }
  // Hard read-only boundary on Facebook surfaces, enforced in Main before
  // any input synthesis: click/type are the only actions that could drive
  // Ads Manager write UIs (budget, bid, delivery switches, publish). They
  // are refused whenever the active panel is on a facebook.com host,
  // regardless of session, permission mode, or caller. Reading actions
  // (navigate/snapshot/screenshot/scroll/back/forward/wait) stay available,
  // and human clicks in the panel never pass through this bridge.
  if (req.action === 'click' || req.action === 'type') {
    const panel = getActiveBrowserPanel()
    const panelUrl = panel && !panel.webContents.isDestroyed() ? panel.webContents.getURL() : null
    if (isFacebookReadOnlyAction(req.action, panelUrl)) {
      return { ok: false, error: 'fb-read-only' }
    }
  }
  switch (req.action) {
    case 'navigate': {
      if (sessionId) latestSnapshotBySession.delete(sessionId)
      const safeUrl = safeBrowserPanelUrl(req.url as string)
      if (!safeUrl) return { ok: false, error: 'invalid-url' }
      const beforeOpen = getActiveBrowserPanel()
      // Start once in Main when a panel exists. Renderer attach/go calls
      // join this promise; repeated explicit refreshes still fetch afresh.
      const navigation = beforeOpen
        ? loadBrowserPanelUrl(beforeOpen.webContents, safeUrl, true).then(
          () => null,
          (error: unknown) => error instanceof Error ? error : new Error('navigation-failed')
        )
        : null
      await openPanelWithUrl(safeUrl, req.keepRoute === true)
      // Join the renderer's pending load instead of aborting it with a
      // second loadURL (getURL still reports the old page while loading).
      const existing = getActiveBrowserPanel()
      if (navigation) {
        const error = await navigation
        if (error) throw error
      } else if (existing) {
        await loadBrowserPanelUrl(existing.webContents, safeUrl)
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
      const text = snap.text.slice(0, MAX_TEXT_CHARS)
      // Evidence chain: FB page snapshots are archived locally so readings
      // keep a verifiable source and parser regressions can be reproduced
      // offline. Best-effort by design — a failed archive never fails the
      // read the user is looking at.
      if (isFacebookSnapshotUrl(snap.url)) {
        try {
          appendFbSnapshot({ url: snap.url, title: snap.title, text })
        } catch {
          // archive is advisory; ignore storage hiccups
        }
      }
      return {
        ok: true,
        url: snap.url,
        title: snap.title,
        text,
        elements: (snap.elements ?? []).slice(0, MAX_ELEMENTS),
        snapshotId: (() => {
          const id = randomUUID()
          if (sessionId) latestSnapshotBySession.set(sessionId, id)
          return id
        })(),
        tabId: getActiveBrowserPanel()?.webContents.id,
        observedAt: Date.now()
      }
    }
    case 'report': {
      // Structured FB reading, hard-verified for automated consumption: two
      // snapshots parsed by the strict shared parser (never by a model),
      // archived as evidence, then gated — rows must equal the page's own
      // campaign count, row sums must equal the page summary, and the two
      // reads must be structurally consistent. ANY gate failing refuses the
      // numbers with a precise reason; no data beats wrong data. Non-Ads-
      // Manager pages fail closed with raw text for agent fallback.
      const readOnce = async () => {
        const snap = await exec<{
        url: string
        title: string
        text: string
        elements: Array<Record<string, unknown>>
      }>(SNAPSHOT_SCRIPT)
        const text = snap.text.slice(0, MAX_TEXT_CHARS)
        if (isFacebookSnapshotUrl(snap.url)) {
          try {
            appendFbSnapshot({ url: snap.url, title: snap.title, text })
          } catch {
            // archive is advisory; ignore storage hiccups
          }
        }
        return {
          url: snap.url,
          title: snap.title,
          text,
          reading: parseFbAdsCampaignsSnapshot({ url: snap.url, title: snap.title, text, observedAt: Date.now() })
        }
      }

      // Fit virtualized rows by temporarily zooming inside the existing
      // panel. Native view bounds must remain owned by the renderer layout.
      const reportPanel = getActiveBrowserPanel()
      if (!reportPanel || reportPanel.webContents.isDestroyed()) return { ok: false, error: 'panel-not-open' }
      // Progressive-render + virtualization retry: both reads must parse AND
      // pass the strict gates before the consistency check (readStableFbReading).
      return withBrowserReadingViewport<BrowserUseResult>(reportPanel, async () => {
        const stable = await readStableFbReading(readOnce, fbAdsReadingRejection)
        if (!stable.ok) {
          return {
            ok: false,
            error: stable.error,
            text: stable.last.text.slice(0, 4_000),
            url: stable.last.url,
            title: stable.last.title
          }
        }
        if (!fbAdsReadingsConsistent(stable.first.reading, stable.second.reading)) {
          return { ok: false, error: 'unstable-page', url: stable.second.url, title: stable.second.title }
        }
        // Verified reading → history (trend foundation for scheduled tasks
        // and boards). Fire-and-forget like the snapshot archive: a storage
        // hiccup never fails the report the user is looking at.
        try {
          appendFbReading(stable.second.reading)
        } catch {
          // history is advisory; ignore storage hiccups
        }
        return {
          ok: true,
          url: stable.second.url,
          title: stable.second.title,
          reading: stable.second.reading,
          verified: true
        }
      })
    }
    case 'history': {
      // Verified-reading history for trends/boards. Metrics per row ride
      // along so a full-metric window hit can serve board cards without a
      // live re-read; entries are small (8 rows typical) so the bridge text
      // cap stays comfortably out of reach.
      const entries = listFbReadings(req.accountId).slice(0, req.limit ?? 10)
      const readings = entries.map((entry) => ({
        capturedAt: entry.capturedAt,
        accountId: entry.accountId,
        accountName: entry.accountName,
        dateRangeLabel: entry.dateRangeLabel,
        campaignCount: entry.campaignCount,
        totalSpend: entry.totalSpend,
        observation: entry.observation,
        rows: entry.rows.map((row) => ({
          name: row.name,
          spend: row.spend,
          costPerResult: row.costPerResult,
          cpm: row.cpm,
          results: row.results,
          clicks: row.clicks,
          ctr: row.ctr,
          cpc: row.cpc,
          installs: row.installs
        }))
      }))
      return { ok: true, readings }
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
      if (sessionId) latestSnapshotBySession.delete(sessionId)
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
      if (sessionId) latestSnapshotBySession.delete(sessionId)
      return { ok: true, url: page.url, title: page.title }
    }
    case 'scroll': {
      const amount = typeof req.amount === 'number' ? req.amount : 4000
      await exec(SCROLL_SCRIPT(req.direction === 'up' ? -amount : amount))
      await new Promise((r) => setTimeout(r, 150))
      const page = currentPage()
      if (sessionId) latestSnapshotBySession.delete(sessionId)
      return { ok: true, url: page.url, title: page.title }
    }
    case 'screenshot': {
      const panel = getActiveBrowserPanel()
      if (!panel) return { ok: false, error: 'panel-not-open' }
      if (!isBrowserPanelVisible()) return { ok: false, error: 'panel-hidden' }
      // Electron can return an empty NativeImage for the first compositor
      // frame after a WebContentsView is shown or reattached. A short bounded
      // retry keeps screenshot fallback deterministic without hanging the
      // bridge when the view is genuinely unavailable.
      let image = await panel.webContents.capturePage()
      for (let attempt = 0; image.isEmpty() && attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        image = await panel.webContents.capturePage()
      }
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
      if (sessionId) latestSnapshotBySession.delete(sessionId)
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
/** The latest DOM snapshot token per runtime session. Mutating the page expires it. */
const latestSnapshotBySession = new Map<string, string>()
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

let boardRefresh: { key: string; result: Promise<FbReadingRefreshResult> } | null = null

/** One bounded refresh, serialized with chat browser tools; no background loop. */
export function refreshBoardFbReading(account: string, range: FbReadingRange): Promise<FbReadingRefreshResult> {
  const key = `${account}:${range}`
  if (boardRefresh) {
    return boardRefresh.key === key ? boardRefresh.result : Promise.resolve({ ok: false, error: 'browser-busy' })
  }
  const today = new Date()
  const expected = boardReadingRangeDates(range, today)
  const target = FB_READING_ACCOUNT_TARGETS[account]
  if (!target) return Promise.resolve({ ok: false, error: 'invalid-input' })
  const result = withBrowserActionLock<FbReadingRefreshResult>(async () => {
    const startedAt = Date.now()
    try {
      const nav = await runAction({ action: 'navigate', url: buildBoardReadingUrl(account, range, today), keepRoute: true })
      if (!nav.ok) return { ok: false, error: nav.error }
      panelOwner = 'board-reading'
      latestSnapshotBySession.clear()
      const report = await runAction({ action: 'report' })
      if (!report.ok) return { ok: false, error: report.error }
      if (!report.verified || !report.reading) return { ok: false, error: 'unverified-reading' }
      if (!fbReadingMatchesWindow(report.reading, target.act, expected)) return { ok: false, error: 'date-mismatch' }
      const entry = listFbReadings(target.act).find((e) =>
        Date.parse(e.capturedAt) >= startedAt && fbReadingMatchesWindow(e, target.act, expected)
      )
      return entry ? { ok: true, entry } : { ok: false, error: 'not-stored' }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return { ok: false, error: message.match(/ERR_[A-Z_]+/)?.[0] ??
        (['navigation-timeout', 'panel-hidden', 'panel-not-open'].includes(message) ? message : 'refresh-failed') }
    }
  }).finally(() => { boardRefresh = null })
  boardRefresh = { key, result }
  return result
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

/** Revoke all bridge credentials and snapshot references for a closed session. */
export function revokeBrowserUseSession(sessionId: string): void {
  for (const [token, owner] of sessionTokens) {
    if (owner === sessionId) sessionTokens.delete(token)
  }
  latestSnapshotBySession.delete(sessionId)
  if (panelOwner === sessionId) panelOwner = null
}

/** Test/internals hook: current ownership state. */
export function browserUseOwner(): string | null {
  return panelOwner
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const unauthorized = (): void => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(serializeBoundedJson({ ok: false, error: 'forbidden' }))
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
    res.end(serializeBoundedJson({ ok: false, error: 'bad-json' }))
    return
  }
  const request = parseBrowserUseRequest(parsed)
  if (!request) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(serializeBoundedJson({ ok: false, error: 'bad-action' }))
    return
  }
  await withBrowserActionLock(async () => {
    const denied = gateBrowserUseRequest(
      request.action,
      sessionId,
      panelOwner,
      isBrowserPanelVisible(),
      request.takeover === true
    )
    if (denied) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        serializeBoundedJson({
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
    // Write-tier extension actions (click/type) are gated by the runtime's
    // own --approval-mode prompt (observed live: "Allow tool: write
    // Path: xd://browser_click"); the bridge stays approval-free to avoid
    // double-prompting.
    try {
      const result = await runAction(request, sessionId)
      if (request.action === 'navigate' && result.ok) {
        panelOwner = sessionId
        latestSnapshotBySession.clear()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(serializeBoundedJson(result))
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(serializeBoundedJson({ ok: false, error: err instanceof Error ? err.message : 'action-failed' }))
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
