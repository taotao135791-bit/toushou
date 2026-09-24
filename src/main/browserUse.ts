import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { BrowserWindow } from 'electron'
import {
  ensureBrowserPanel,
  getActiveBrowserPanel,
  isBrowserPanelVisible,
  loadBrowserPanelUrl,
  withBrowserReadingViewport
} from './browserPanel'
import { appendFbSnapshot, isFacebookSnapshotUrl } from './fbSnapshots'
import { safeBrowserPanelUrl } from './navigation'
import { IPC_CHANNELS } from '../shared/constants'
import {
  fbAdsReadingsConsistent,
  fbAdsReadingRejection,
  mergeFbAdsCampaignReadings,
  parseFbAdsCampaignsSnapshot
} from '../shared/fbAdsParser'
import type { FbAdsCampaignReading } from '../shared/fbAdsParser'
import {
  boardReadingRangeDates,
  buildFbAccountOverviewUrlForRef,
  buildFbReadingUrlForRef,
  fbReadingMatchesWindow,
  isValidFbReadingAct,
  isValidFbReadingBusinessId
} from '../shared/fbReading'
import type {
  FbReadingAccountDiscoveryResult,
  FbAccountBalanceRefreshResult,
  FbReadingAccountRef,
  FbReadingRange,
  FbReadingRefreshResult
} from '../shared/fbReading'
import { parseFbAccountBalanceSnapshot, type FbAccountBalanceParseResult } from '../shared/fbBillingParser'
import { appendFbReading, listFbReadings } from './fbReadings'
import { listFbReadingAccounts } from './fbReadingAccounts'
import { saveFbAccountBalance } from './fbBalances'
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
  /** Internal read-only board refresh: drive a detached persistent panel. */
  background?: boolean
  /** Internal callers may extend the navigation deadline (cold FB loads). */
  navTimeoutMs?: number
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
  | { ok: true; url?: string; title?: string; text?: string; elements?: Array<Record<string, unknown>>; imagePath?: string; reading?: FbAdsCampaignReading; verified?: boolean; stored?: boolean | string; readings?: unknown[]; snapshotId?: string; tabId?: number; observedAt?: number; truncated?: boolean }
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

/**
 * Ads Manager freezes the campaign-name column. When that pane is 0-width
 * (hidden/background panel, or a narrow placeholder), innerText drops the
 * names and the strict parser sees only metrics. Prefer a reconstructed
 * table from role=row cells so the parser receives one ordered table, not
 * pageText with a duplicate table appended after the summary.
 */
export const FB_ADS_TABLE_SNAPSHOT_SCRIPT = `(() => {
  const root = document.querySelector('main') || document.querySelector('article') || document.body
  const pageText = (root && root.innerText ? root.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
  const cellText = (el) => {
    const visible = (el.innerText || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').replace(/\\n+/g, '\\n').trim()
    if (visible) return visible
    return (el.textContent || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').replace(/\\n+/g, '\\n').trim()
  }
  const linesFrom = (value) => value.split(/\\n/).map((line) => line.trim()).filter(Boolean)
  const tableLines = []
  const seen = new Set()
  for (const row of document.querySelectorAll('[role="row"]')) {
    const cells = Array.from(row.querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"]'))
    const chunks = []
    if (cells.length > 0) {
      for (const cell of cells) {
        const text = cellText(cell)
        if (text) chunks.push(...linesFrom(text))
      }
    } else {
      const fallback = cellText(row)
      if (fallback) chunks.push(...linesFrom(fallback))
    }
    if (chunks.length === 0) continue
    const key = chunks.join('\\u001f')
    if (seen.has(key)) continue
    seen.add(key)
    tableLines.push(...chunks)
  }
  let text = pageText
  if (tableLines.length > 1) {
    const headerIdx = tableLines.findIndex((line) => line === '关/开' || line === 'On/Off')
    const customizeIdx = tableLines.findIndex((line, idx) => idx > headerIdx && (line === '定制列...' || line === '定制列…' || /^Customize columns/i.test(line)))
    if (headerIdx >= 0 && customizeIdx > headerIdx) {
      const prefixEnd = pageText.search(/(?:^|\\n)(?:关\\/开|On\\/Off)(?:\\n|$)/)
      if (prefixEnd >= 0) {
        const prefix = pageText.slice(0, prefixEnd).replace(/\\n+$/, '')
        const table = tableLines.slice(headerIdx).join('\\n')
        text = [prefix, table].filter(Boolean).join('\\n')
      }
    }
  }
  text = text.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${MAX_TEXT_CHARS})
  return { url: location.href, title: document.title, text, elements: [] }
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
function tableScrollScript(action: 'reset' | 'by', delta = 0): string {
  return `(() => {
    const action = ${JSON.stringify(action)}
    const delta = ${delta}
    const tableRe = /广告系列|Campaigns?|已花费金额|Amount spent|关\\/开|On\\/Off/
    let best = null
    let bestScore = -1
    for (const el of document.querySelectorAll('div')) {
      const style = window.getComputedStyle(el)
      if (!(style.overflowY === 'auto' || style.overflowY === 'scroll')) continue
      const room = el.scrollHeight - el.clientHeight
      if (el.clientHeight < 80 || room <= 4) continue
      const text = (el.innerText || '').slice(0, 4_000)
      const table = tableRe.test(text)
      const score = (table ? 100000 : 0) + room + Math.min(el.clientHeight, 4000)
      if (score > bestScore) { best = el; bestScore = score }
    }
    if (action === 'reset') {
      window.scrollTo(0, 0)
      if (best) best.scrollTop = 0
      return { moved: true, before: 0, after: best ? best.scrollTop : 0, room: best ? best.scrollHeight - best.clientHeight : 0, client: best ? best.clientHeight : 0 }
    }
    window.scrollBy({ top: delta })
    if (!best) return { moved: false, before: 0, after: 0, room: 0, client: 0 }
    const before = best.scrollTop
    best.scrollBy({ top: delta })
    const after = best.scrollTop
    return { moved: after !== before, before, after, room: best.scrollHeight - best.clientHeight, client: best.clientHeight }
  })()`
}

export const SCROLL_SCRIPT = (delta: number): string => tableScrollScript('by', delta)

export const RESET_TABLE_SCROLL_SCRIPT = tableScrollScript('reset')

export interface FbVirtualizedScrollResult {
  moved?: boolean
  client?: number
  room?: number
}

export interface FbVirtualizedPageResult<R> {
  parts: R[]
  expected: number | null
  stop: FbReadOnce<R> | null
}

/**
 * Scroll a virtualized Ads Manager table from the current seed downward.
 * Callers must reset to the top and re-read the seed before each pass.
 */
export async function collectVirtualizedFbPages<
  R extends { campaignCount: number | null; rows: Array<{ name: string }> }
>(
  seed: FbReadOnce<R>,
  opts: {
    readOnce: () => Promise<FbReadOnce<R>>
    scroll: (delta: number) => Promise<FbVirtualizedScrollResult>
    sleep?: (ms: number) => Promise<void>
    assertActive?: () => void
    isTerminal?: (snap: FbReadOnce<R>) => boolean
    maxPages?: number
  }
): Promise<FbVirtualizedPageResult<R>> {
  const parts: R[] = seed.reading ? [seed.reading] : []
  let expected = seed.reading?.campaignCount ?? null
  const namesOf = () => new Set(parts.flatMap((part) => part.rows.map((row) => row.name)))
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let stalled = 0
  let step = 0
  const maxPages = opts.maxPages ?? 24
  const probe = await opts.scroll(0).catch(() => ({ moved: false, client: 0 }))
  if (probe.client && probe.client > 0) step = Math.max(240, Math.round(probe.client * 0.8))
  for (let page = 0; page < maxPages; page += 1) {
    if (expected !== null && namesOf().size >= expected) break
    if (step <= 0) break
    opts.assertActive?.()
    const scrolled = await opts.scroll(step).catch(() => ({ moved: false, client: 0 }))
    if (scrolled.client && scrolled.client > 0) step = Math.max(240, Math.round(scrolled.client * 0.8))
    await sleep(350)
    const next = await opts.readOnce()
    if (opts.isTerminal?.(next)) return { parts, expected, stop: next }
    const before = namesOf().size
    if (next.reading) {
      parts.push(next.reading)
      if (expected === null) expected = next.reading.campaignCount
    }
    if (namesOf().size === before && scrolled.moved === false) {
      stalled += 1
      if (stalled >= 2) break
    } else stalled = 0
  }
  return { parts, expected, stop: null }
}

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
  opts: {
    delayMs?: number
    firstAttempts?: number
    secondAttempts?: number
    settleDelayMs?: number
    /** Weak-network budget: checked between reads; throwing stops all later reads. */
    assertActive?: () => void
  } = {}
): Promise<
  | { ok: true; first: FbReadOnce<R> & { reading: R }; second: FbReadOnce<R> & { reading: R } }
  | { ok: false; error: string; last: FbReadOnce<R> }
> {
  // Cold loads of Ads Manager (fresh panel after an app restart) can take
  // 30s+ past domcontentloaded before the SPA mounts table rows — and
  // proxied/slow networks push row mounting past 30s (measured ~33s behind
  // a local proxy); 40 × 1.5s covers that without hanging the bridge on a
  // dead page.
  const { delayMs = 1_500, firstAttempts = 40, secondAttempts = 3, settleDelayMs = 700 } = opts
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const stableRead = async (attempts: number): Promise<FbReadOnce<R>> => {
    let last: FbReadOnce<R> | null = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      opts.assertActive?.()
      if (attempt > 0) await sleep(delayMs)
      opts.assertActive?.()
      last = await readOnce()
      if (fbPageLoadFailure(last) || fbLoginWall(last) || (last.reading && !rejectionOf(last.reading))) return last
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
  opts.assertActive?.()
  await sleep(settleDelayMs)
  opts.assertActive?.()
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

/** FB bounces to these when the persistent panel lost its login state. */
function fbLoginWall(page: { url: string; title: string }): boolean {
  return /https?:\/\/([a-z0-9-]+\.)?facebook\.com\/login/i.test(page.url) ||
    /business\.facebook\.com\/business\/loginpage/i.test(page.url) ||
    /(?:^|\s)(?:登录 Facebook|Log in to Facebook)(?:$|\s)/i.test(page.title)
}

/** Meta can demand a fresh 2FA even when ordinary Ads Manager stays logged in. */
function fbReauthWall(page: { url: string; title: string }): boolean {
  return /\/security\/twofactor\/reauth\//.test(page.url) || /2FA Entry/i.test(page.title)
}

function exec<T>(script: string, requireVisible = true): Promise<T> {
  const panel = getActiveBrowserPanel()
  if (!panel) return Promise.reject(new Error('panel-not-open'))
  if (requireVisible && !isBrowserPanelVisible()) return Promise.reject(new Error('panel-hidden'))
  return panel.webContents.executeJavaScript(script, true) as Promise<T>
}

function currentPage(requireVisible = true): { url: string; title: string } {
  const panel = getActiveBrowserPanel()
  if (!panel) throw new Error('panel-not-open')
  if (panel.webContents.isDestroyed()) throw new Error('panel-not-open')
  if (requireVisible && !isBrowserPanelVisible()) throw new Error('panel-hidden')
  return { url: panel.webContents.getURL(), title: panel.webContents.getTitle() }
}

/** currentPage for paths that must survive a missing/destroyed panel. */
function safeCurrentPage(): { url: string; title: string } | null {
  try {
    return currentPage(false)
  } catch {
    return null
  }
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

export async function runAction(
  req: BrowserUseRequest,
  sessionId?: string,
  // Internal-only weak-network budget for board reads. Never part of
  // parseBrowserUseRequest, so bridge callers cannot supply it.
  readControl?: BoardReadControl
): Promise<BrowserUseResult> {
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
      if (req.background === true) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) ensureBrowserPanel(win)
        }
      }
      const beforeOpen = getActiveBrowserPanel()
      // Start once in Main when a panel exists. Renderer attach/go calls
      // join this promise; repeated explicit refreshes still fetch afresh.
      const navigation = beforeOpen
        ? loadBrowserPanelUrl(beforeOpen.webContents, safeUrl, true, req.navTimeoutMs).then(
          () => null,
          (error: unknown) => error instanceof Error ? error : new Error('navigation-failed')
        )
        : null
      if (req.background !== true) await openPanelWithUrl(safeUrl, req.keepRoute === true)
      // Join the renderer's pending load instead of aborting it with a
      // second loadURL (getURL still reports the old page while loading).
      const existing = getActiveBrowserPanel()
      if (navigation) {
        const error = await navigation
        if (error) throw error
      } else if (existing) {
        await loadBrowserPanelUrl(existing.webContents, safeUrl, false, req.navTimeoutMs)
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
      }>(SNAPSHOT_SCRIPT, req.background !== true)
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
      }>(FB_ADS_TABLE_SNAPSHOT_SCRIPT, req.background !== true)
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
        const controlOpts = readControl
          ? { assertActive: () => assertBoardReadActive(readControl) }
          : {}
        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
        const collectPass = async () => {
          await exec(RESET_TABLE_SCROLL_SCRIPT, false).catch(() => undefined)
          await sleep(350)
          const seed = await readOnce()
          if (fbPageLoadFailure(seed) || fbLoginWall(seed) || !seed.reading) {
            return { seed, pass: { parts: seed.reading ? [seed.reading] : [], expected: seed.reading?.campaignCount ?? null, stop: seed } }
          }
          const pass = await collectVirtualizedFbPages(seed, {
            readOnce,
            scroll: (delta) => exec<FbVirtualizedScrollResult>(SCROLL_SCRIPT(delta), false),
            sleep,
            assertActive: controlOpts.assertActive,
            isTerminal: (snap) => fbPageLoadFailure(snap) || fbLoginWall(snap)
          })
          return { seed, pass }
        }
        const failFrom = (snap: FbReadOnce<FbAdsCampaignReading>, error: string): BrowserUseResult => ({
          ok: false,
          error,
          text: snap.text.slice(0, 4_000),
          url: snap.url,
          title: snap.title
        })
        // Wait for the campaigns table to parse at all (cold Ads Manager can
        // take 30s). A headers-only snapshot is unparseable, not incomplete.
        // Board refresh has one total deadline and may need a single wide-view
        // reload afterward. Keep its warm-up bounded so the fallback still has
        // time to take one verified read; interactive browser reports retain
        // the longer cold-load budget above.
        const warmed = await readStableFbReading(readOnce, () => null, {
          ...controlOpts,
          ...(readControl ? { firstAttempts: 24, delayMs: 1_000 } : {}),
          secondAttempts: 1
        })
        if (!warmed.ok && warmed.error !== 'unparseable-page') {
          return failFrom(warmed.last, warmed.error)
        }
        const firstPass = await collectPass()
        if (fbPageLoadFailure(firstPass.seed) || (firstPass.pass.stop && fbPageLoadFailure(firstPass.pass.stop))) {
          return failFrom(firstPass.pass.stop ?? firstPass.seed, 'page-load-failed')
        }
        if (fbLoginWall(firstPass.seed) || (firstPass.pass.stop && fbLoginWall(firstPass.pass.stop))) {
          return failFrom(firstPass.pass.stop ?? firstPass.seed, 'login-required')
        }
        const firstMerged = mergeFbAdsCampaignReadings(firstPass.pass.parts)
        if (!firstMerged || fbAdsReadingRejection(firstMerged) !== null) {
          return failFrom(
            firstPass.pass.stop ?? firstPass.seed,
            firstMerged ? (fbAdsReadingRejection(firstMerged) ?? 'incomplete-view') : 'unparseable-page'
          )
        }
        const secondPass = await collectPass()
        if (fbPageLoadFailure(secondPass.seed) || (secondPass.pass.stop && fbPageLoadFailure(secondPass.pass.stop))) {
          return failFrom(secondPass.pass.stop ?? secondPass.seed, 'page-load-failed')
        }
        if (fbLoginWall(secondPass.seed) || (secondPass.pass.stop && fbLoginWall(secondPass.pass.stop))) {
          return failFrom(secondPass.pass.stop ?? secondPass.seed, 'login-required')
        }
        const secondMerged = mergeFbAdsCampaignReadings(secondPass.pass.parts)
        if (!secondMerged) {
          return failFrom(secondPass.seed, 'unparseable-page')
        }
        if (fbAdsReadingRejection(secondMerged) !== null) {
          return failFrom(secondPass.seed, fbAdsReadingRejection(secondMerged) ?? 'incomplete-view')
        }
        const firstSnap = { ...firstPass.seed, reading: firstMerged }
        const secondSnap = { ...secondPass.seed, reading: secondMerged }
        if (!fbAdsReadingsConsistent(firstSnap.reading, secondSnap.reading)) {
          return { ok: false, error: 'unstable-page', url: secondSnap.url, title: secondSnap.title }
        }
        // Verified reading → history (trend foundation for scheduled tasks
        // and boards). Fire-and-forget like the snapshot archive: a storage
        // hiccup never fails the report the user is looking at.
        // History is advisory for the chat path, but the board refresh
        // needs to know when storage failed so it can report precisely.
        let stored: boolean | string = true
        try {
          readControl && assertBoardReadActive(readControl)
          const append = appendFbReading(secondSnap.reading)
          stored = append.ok ? true : (append.error ?? 'append-failed')
        } catch (error) {
          if (error instanceof Error && error.message === 'refresh-timeout') throw error
          stored = error instanceof Error ? error.message : 'append-threw'
        }
        return {
          ok: true,
          url: secondSnap.url,
          title: secondSnap.title,
          reading: secondSnap.reading,
          verified: true,
          stored
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
          impressions: row.impressions,
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
let balanceRefresh: { key: string; result: Promise<FbAccountBalanceRefreshResult> } | null = null

/**
 * Weak-network budget for ONE refreshBoardFbReading call (renderer retries
 * by calling again). Covers queue wait AND execution; phases never re-grant
 * the full budget. assertActive() throws refresh-timeout, which stops every
 * later read — a late DOM result can never be parsed into verified history.
 */
const BOARD_READ_QUEUE_BUDGET_MS = 15_000
const BOARD_READ_TOTAL_BUDGET_MS = 85_000

interface BoardReadControl {
  queueDeadline: number
  deadline: number
  assertActive(): void
}

function assertBoardReadActive(control: BoardReadControl): void {
  if (Date.now() > control.deadline) throw new Error('refresh-timeout')
}

/** Opens the Ads Manager account switcher unless its menu is already open. */
const OPEN_ACCOUNT_SWITCHER_SCRIPT = `(() => {
  const bodyText = document.body.innerText || ''
  const menuOpen = bodyText.includes('业务资产组合') || bodyText.includes('Business portfolios') ||
    Array.from(document.querySelectorAll('input')).some(i => (i.placeholder || '').includes('搜索广告账户'))
  if (menuOpen) return true
  const combobox = document.querySelector('[role=combobox]')
  if (combobox) { combobox.click(); return true }
  const pattern = /\\((\\d{6,})\\)/
  let best = null
  let bestLength = Infinity
  for (const node of document.querySelectorAll('div,span,button,a')) {
    const text = (node.textContent || '').trim()
    if (text.length === 0 || text.length > 90 || !pattern.test(text)) continue
    if (text.length < bestLength) { best = node; bestLength = text.length }
  }
  if (best) { best.click(); return true }
  return false
})()`

/** Scrolls the switcher menu one page; false when it is already at the bottom. */
const SCROLL_ACCOUNT_MENU_SCRIPT = `(() => {
  let best = null
  let room = 0
  for (const el of document.querySelectorAll('div')) {
    const style = window.getComputedStyle(el)
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 8) {
      const current = el.scrollHeight - el.clientHeight
      if (current > room) { best = el; room = current }
    }
  }
  if (!best) return false
  const before = best.scrollTop
  best.scrollTop = Math.min(before + Math.max(160, best.clientHeight * 0.85), best.scrollHeight)
  best.dispatchEvent(new Event('scroll'))
  return best.scrollTop > before
})()`

/** Finds the open switcher menu root via its bilingual section header, or null. */
const SWITCHER_MENU_JS = `(() => {
  const holders = []
  for (const el of document.querySelectorAll('div,section')) {
    if (!el.childElementCount) continue
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim()
    if ((text.includes('Business portfolios') || text.includes('业务资产组合')) &&
        /(ad accounts?|个广告账户)/.test(text) && text.length > 40 && text.length < 6000) holders.push(el)
  }
  const outer = holders.filter(el => !holders.some(o => o !== el && o.contains(el)))
  return outer.length ? outer[outer.length - 1] : null
})()`

/** Reports whether the switcher menu is currently open. */
const SWITCHER_MENU_PRESENT_SCRIPT = `(() => ${SWITCHER_MENU_JS} !== null)()`

/**
 * Lists the business-portfolio group rows in the open switcher. Rows are
 * parsed from innerText (layout text keeps name and count separated, while
 * textContent concatenates them — "Adtiger-C130 ad accounts" — which makes
 * digit-suffixed portfolio names ambiguous). A row is "name + count", or a
 * bare count when FB renders them as separate elements. Bilingual:
 * "X 个广告账户" and "N ad account(s)".
 */
export const FIND_GROUP_ROWS_SCRIPT = `(() => {
  const menu = ${SWITCHER_MENU_JS}
  if (!menu) return null
  const excluded = /business portfolio|业务资产组合|other assets|其他资产/i
  const named = []
  const counts = []
  for (const el of menu.querySelectorAll('div,span,a,[role=row],[role=button]')) {
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!text || text.length > 70) continue
    const m = text.match(/^(.{1,50}?)\\s*(\\d+)\\s*(?:个广告账户|ad\\saccounts?)(?:\\s*·.*)?$/)
    if (!m) continue
    let name = m[1].trim()
    let count = m[2]
    // For a bare row like "10 ad accounts", the lazy name capture can eat
    // the first digit and leave only "0" as the account count.
    if (name && /^\\d+$/.test(name)) {
      count = name + count
      name = ''
    }
    if (name && /[\\u4e00-\\u9fa5a-z]/i.test(name)) {
      if (!excluded.test(name)) named.push({ el, name })
    } else counts.push({ el, count })
  }
  const uniqueNamed = named.filter(row => !named.some(other => other.el !== row.el && row.el.contains(other.el)))
  const uniqueCounts = counts.filter(row => !counts.some(other => other.el !== row.el && row.el.contains(other.el)))
  const nameOccurrences = new Map()
  const nameLabels = uniqueNamed.map(row => {
    const occurrence = nameOccurrences.get(row.name) || 0
    nameOccurrences.set(row.name, occurrence + 1)
    return encodeURIComponent(row.name) + '#' + occurrence
  })
  const countOccurrences = new Map()
  const countLabels = uniqueCounts.map(row => {
    const occurrence = countOccurrences.get(row.count) || 0
    countOccurrences.set(row.count, occurrence + 1)
    return row.count + '#' + occurrence
  })
  return {
    named: nameLabels.slice(0, 12),
    counts: countLabels.slice(0, 12),
    truncated: uniqueNamed.length > 12 || uniqueCounts.length > 12
  }
})()`

/** Clicks one business-portfolio group row (by name, or by bare count). */
export const CLICK_GROUP_ROW_SCRIPT = (label: string, named: boolean): string => `(() => {
  const menu = ${SWITCHER_MENU_JS}
  if (!menu) return false
  const wanted = ${JSON.stringify(label)}
  const wantNamed = ${named ? 'true' : 'false'}
  const [wantedValue, wantedOccurrenceText] = wanted.split('#')
  const wantedOccurrence = Number(wantedOccurrenceText || 0)
  const wantedName = wantNamed ? decodeURIComponent(wantedValue) : ''
  const wantedCount = wantNamed ? '' : wantedValue
  const excluded = /business portfolio|业务资产组合|other assets|其他资产/i
  const matches = []
  for (const el of menu.querySelectorAll('div,span,a,[role=row],[role=button]')) {
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!text || text.length > 70) continue
    const m = text.match(/^(.{1,50}?)\\s*(\\d+)\\s*(?:个广告账户|ad\\saccounts?)(?:\\s*·.*)?$/)
    if (!m) continue
    let name = m[1].trim()
    let count = m[2]
    if (name && /^\\d+$/.test(name)) {
      count = name + count
      name = ''
    }
    const isNamed = !!name && /[\\u4e00-\\u9fa5a-z]/i.test(name) && !excluded.test(name)
    if (isNamed !== wantNamed) continue
    if ((isNamed ? name : count) !== (isNamed ? wantedName : wantedCount)) continue
    matches.push({ el, label: isNamed ? name : count })
  }
  const targets = matches.filter(row => !matches.some(other => other.el !== row.el && row.el.contains(other.el)))
  const target = targets[wantedOccurrence]
  if (!target) return false
  target.el.click()
  return true
})()`

/** Clicks the switcher menu's "View more" / "查看更多" pagination once. */
const CLICK_VIEW_MORE_SCRIPT = `(() => {
  const menu = ${SWITCHER_MENU_JS}
  if (!menu) return false
  const matches = []
  for (const el of menu.querySelectorAll('div,span,a,button,[role=button]')) {
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (/^(View more|查看更多|显示更多)$/i.test(text)) matches.push(el)
  }
  const targets = matches.filter(el => !matches.some(o => o !== el && el.contains(o)))
  if (!targets.length) return false
  targets[targets.length - 1].click()
  return true
})()`

/** Whether pagination remains after the defensive View more click cap. */
const VIEW_MORE_PRESENT_SCRIPT = `(() => {
  const menu = ${SWITCHER_MENU_JS}
  if (!menu) return false
  return Array.from(menu.querySelectorAll('div,span,a,button,[role=button]'))
    .some(el => /^(View more|查看更多|显示更多)$/i.test((el.textContent || '').replace(/\\s+/g, ' ').trim()))
})()`

/** Structured account harvest from the open switcher menu (DOM, not text lines). */
const HARVEST_ACCOUNTS_SCRIPT = `(() => {
  const found = new Map()
  const consider = (name, act) => {
    if (!act || !/^\\d{6,20}$/.test(act)) return
    const label = (name || '').trim().slice(0, 60) || act
    const prev = found.get(act)
    if (!prev) { found.set(act, label); return }
    // A real name always beats the bare-ID fallback; among equals, keep the
    // shortest (trims wrapper text from nested nodes).
    const prevFallback = prev === act
    const labelFallback = label === act
    if (prevFallback && !labelFallback) found.set(act, label)
    else if (prevFallback === labelFallback && label.length < prev.length) found.set(act, label)
  }
  for (const el of document.querySelectorAll('div,span,a,button,li,[role=row],[role=option],[role=menuitem]')) {
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!text || text.length > 140) continue
    let m = text.match(/^(.{1,60}?)\\s*[（(](\\d{6,20})[)）]/)
    if (m) { consider(m[1], m[2]); continue }
    m = text.match(/^(.{1,60}?)\\s*广告账户编号[：:]\\s*(\\d{6,20})/)
    if (m) { consider(m[1], m[2]); continue }
    m = text.match(/^广告账户编号[：:]\\s*(\\d{6,20})$/)
    if (m) { consider(m[1], m[1]); continue }
    m = text.match(/^(.{1,60}?)\\s*Ad account ID[：:]\\s*(\\d{6,20})/)
    if (m) { consider(m[1], m[2]); continue }
    m = text.match(/^Ad account ID[：:]\\s*(\\d{6,20})$/)
    if (m) consider(m[1], m[1])
  }
  return Array.from(found.entries()).map(([act, name]) => ({ name, act }))
})()`

/** Types a keyword into the switcher search box; matched accounts render flat. */
const TYPE_ACCOUNT_SEARCH_SCRIPT = (query: string): string => `(() => {
  const input = Array.from(document.querySelectorAll('input')).find(i => {
    const placeholder = i.placeholder || ''
    return placeholder.includes('搜索广告账户') || /^search/i.test(placeholder)
  })
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(query)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

/**
 * Enumerate the ad accounts the logged-in FB identity can access. The
 * switcher groups accounts under collapsed business portfolios and paginates
 * each expanded group behind "View more", so sweep every group (bilingual
 * zh/en selectors), harvesting structured rows after every step, then
 * navigate back so no menu stays open. Read-only; failures are precise.
 */
export async function discoverFbReadingAccounts(query = ''): Promise<FbReadingAccountDiscoveryResult> {
  return withBrowserActionLock<FbReadingAccountDiscoveryResult>(async () => {
    // A bare campaigns URL makes FB run its global-scope redirect chain,
    // which can abort the initial load (ERR_ABORTED, errno -3). Stay on the
    // current campaigns page when we are already on one; otherwise pin the
    // navigation to a registry account so no scope selector kicks in.
    const campaignsHere = (page: { url: string }) => /adsmanager\.facebook\.com\/adsmanager\/manage\/campaigns/.test(page.url)
    // A missing/destroyed panel starts from scratch: the background
    // navigate below creates one (this used to throw before any try).
    const startUrl = safeCurrentPage()?.url ?? ''
    const alreadyThere = campaignsHere({ url: startUrl })
    const pinned = listFbReadingAccounts()[0]
    const targetUrl = alreadyThere
      ? startUrl
      : pinned
        ? buildFbReadingUrlForRef(pinned, 'today')
        : 'https://adsmanager.facebook.com/adsmanager/manage/campaigns'
    if (!alreadyThere) {
      try {
        const nav = await runAction({
          action: 'navigate',
          url: targetUrl,
          keepRoute: true,
          background: true,
          navTimeoutMs: 45_000
        })
        const afterNav = safeCurrentPage()
        if (!nav.ok && !(afterNav && campaignsHere(afterNav))) return { ok: false, error: nav.error }
      } catch {
        // Redirect chains can abort the load yet still land correctly.
        const afterNav = safeCurrentPage()
        if (!afterNav || !campaignsHere(afterNav)) return { ok: false, error: 'navigation-failed' }
      }
    }
    const landed = safeCurrentPage()
    if (!landed) return { ok: false, error: 'panel-not-open' }
    if (fbLoginWall(landed)) return { ok: false, error: 'login-required' }
    await waitForLoad(20_000, false)
    const panel = getActiveBrowserPanel()
    if (!panel || panel.webContents.isDestroyed()) return { ok: false, error: 'panel-not-open' }
    // The Ads Manager chrome (combobox included) can take 10s+ to appear
    // on a slow load; retry instead of bailing after one attempt.
    let opened = false
    for (let attempt = 0; attempt < 6 && !opened; attempt += 1) {
      try {
        opened = await panel.webContents.executeJavaScript(OPEN_ACCOUNT_SWITCHER_SCRIPT, true) as boolean
      } catch {
        opened = false
      }
      if (!opened) await new Promise((resolve) => setTimeout(resolve, 2_500))
    }
    if (!opened) return { ok: false, error: 'switcher-not-found' }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const seen = new Set<string>()
    const byAct = new Map<string, string>()
    const deadline = Date.now() + 150_000
    let complete = true
    const harvest = async () => {
      const found = await panel.webContents.executeJavaScript(HARVEST_ACCOUNTS_SCRIPT, true) as Array<{ name?: unknown; act?: unknown }>
      for (const item of Array.isArray(found) ? found : []) {
        if (typeof item?.act !== 'string' || seen.has(item.act)) continue
        seen.add(item.act)
        byAct.set(item.act, typeof item.name === 'string' && item.name ? item.name : item.act)
      }
    }
    try {
      const menuLive = async (): Promise<boolean> =>
        (await panel.webContents.executeJavaScript(SWITCHER_MENU_PRESENT_SCRIPT, true)
          .catch(() => false)) === true
      const ensureMenu = async (): Promise<boolean> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (await menuLive()) return true
          try {
            await panel.webContents.executeJavaScript(OPEN_ACCOUNT_SWITCHER_SCRIPT, true)
          } catch {
            return false
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
        return await menuLive()
      }
      const sweepMorePages = async (limit: number): Promise<void> => {
        let reachedPaginationEnd = false
        for (let more = 0; more < limit; more += 1) {
          if (Date.now() >= deadline) {
            complete = false
            break
          }
          const clicked = await panel.webContents
            .executeJavaScript(CLICK_VIEW_MORE_SCRIPT, true).catch(() => null) as boolean | null
          if (clicked === null) {
            complete = false
            break
          }
          if (!clicked) {
            reachedPaginationEnd = await menuLive()
            if (!reachedPaginationEnd) complete = false
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 1_100))
          await harvest()
        }
        if (!reachedPaginationEnd && Date.now() < deadline) {
          const hasMore = await panel.webContents
            .executeJavaScript(VIEW_MORE_PRESENT_SCRIPT, true).catch(() => null) as boolean | null
          if (hasMore !== false) complete = false
        }
      }
      // Harvest one expanded group completely: click "View more" until the
      // button is gone (each click appends another page of accounts), then
      // page through the scroll container.
      const sweepGroup = async (deadline: number): Promise<void> => {
        await harvest()
        await sweepMorePages(10)
        let reachedScrollEnd = false
        for (let page = 0; page < 12; page += 1) {
          if (Date.now() >= deadline) {
            complete = false
            break
          }
          await harvest()
          const moved = await panel.webContents
            .executeJavaScript(SCROLL_ACCOUNT_MENU_SCRIPT, true).catch(() => null) as boolean | null
          if (moved === null) {
            complete = false
            reachedScrollEnd = true
            break
          }
          if (!moved) {
            if (!await menuLive()) complete = false
            reachedScrollEnd = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 550))
        }
        if (!reachedScrollEnd && Date.now() < deadline) {
          const moved = await panel.webContents
            .executeJavaScript(SCROLL_ACCOUNT_MENU_SCRIPT, true).catch(() => null) as boolean | null
          if (moved !== false) complete = false
        }
        await harvest()
      }
      if (query !== '') {
        const typed = await panel.webContents.executeJavaScript(TYPE_ACCOUNT_SEARCH_SCRIPT(query), true) as boolean
        if (!typed) return { ok: false, error: 'search-not-found' }
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        await harvest()
        await sweepMorePages(10)
        let reachedScrollEnd = false
        for (let page = 0; page < 24; page += 1) {
          if (Date.now() >= deadline) {
            complete = false
            break
          }
          await harvest()
          const moved = await panel.webContents.executeJavaScript(SCROLL_ACCOUNT_MENU_SCRIPT, true).catch(() => null) as boolean | null
          if (moved === null) {
            complete = false
            reachedScrollEnd = true
            break
          }
          if (!moved) {
            if (!await menuLive()) complete = false
            reachedScrollEnd = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 550))
        }
        if (!reachedScrollEnd && Date.now() < deadline) {
          const moved = await panel.webContents
            .executeJavaScript(SCROLL_ACCOUNT_MENU_SCRIPT, true).catch(() => null) as boolean | null
          if (moved !== false) complete = false
        }
        await harvest()
      } else {
        // Full-portfolio sweep: the switcher collapses every business
        // portfolio into one row and paginates expanded groups behind a
        // "View more" button. Harvest the group FB auto-expands (the one
        // holding the current account), then walk every other group row.
        if (!await ensureMenu()) return { ok: false, error: 'switcher-not-found' }
        await sweepGroup(deadline)
        const groups = await panel.webContents
          .executeJavaScript(FIND_GROUP_ROWS_SCRIPT, true).catch(() => null) as
          { named: string[]; counts: string[]; truncated?: boolean } | null
        if (groups) {
          if (groups.truncated) complete = false
          const rows: Array<{ label: string; named: boolean }> = [
            ...groups.named.map((label) => ({ label, named: true })),
            ...groups.counts.map((label) => ({ label, named: false }))
          ]
          for (const row of rows) {
            if (Date.now() >= deadline) {
              complete = false
              break
            }
            const clicked = await panel.webContents
              .executeJavaScript(CLICK_GROUP_ROW_SCRIPT(row.label, row.named), true).catch(() => false) as boolean
            if (!clicked) {
              complete = false
              continue
            }
            await new Promise((resolve) => setTimeout(resolve, 1_600))
            if (!await ensureMenu()) {
              complete = false
              break
            }
            await sweepGroup(deadline)
          }
        } else {
          complete = false
        }
        await harvest()
      }
    } catch {
      return { ok: false, error: 'unparseable-page' }
    } finally {
      // Always close the account switcher and restore the campaigns route,
      // including early returns when the query field/menu disappears.
      await runAction({
        action: 'navigate',
        url: targetUrl,
        keepRoute: true,
        background: true,
        navTimeoutMs: 45_000
      }).catch(() => undefined)
    }
    const accounts = Array.from(byAct.entries()).map(([act, name]) => ({ name, act }))
    return accounts.length > 0
      ? { ok: true as const, accounts, complete }
      : { ok: false as const, error: 'accounts-not-found' }
  }).catch((error: unknown) => {
    // Never let a bare panel throw escape as an unhandled rejection.
    const message = error instanceof Error ? error.message : ''
    return { ok: false as const, error: ['panel-not-open', 'panel-hidden'].includes(message) ? message : 'discover-failed' }
  })
}

/**
 * Deterministic account capture: the panel URL already carries act (and
 * often business_id) after the user clicks into an account. No menu
 * parsing, no FB-UI fragility — the page IS the source of truth.
 */
export function captureFbReadingAccountFromPanel(): {
  ok: boolean
  account?: { act: string; businessId: string | null }
  error?: string
} {
  let url: string
  try {
    url = currentPage(false).url
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && ['panel-not-open', 'panel-hidden'].includes(error.message)
        ? error.message
        : 'panel-not-open'
    }
  }
  if (!/adsmanager\.facebook\.com\/adsmanager\/manage\/campaigns/.test(url)) {
    return { ok: false, error: 'not-on-adsmanager' }
  }
  const act = url.match(/[?&]act=(\d{6,20})/)?.[1]
  if (!act) return { ok: false, error: 'not-on-adsmanager' }
  const businessId = url.match(/[?&]business_id=(\d{6,20})/)?.[1] ?? null
  return { ok: true, account: { act, businessId } }
}

/** One bounded refresh, serialized with chat browser tools; no background loop. */
export function refreshBoardFbReading(ref: FbReadingAccountRef, range: FbReadingRange): Promise<FbReadingRefreshResult> {
  const today = new Date()
  const expected = boardReadingRangeDates(range, today)
  const known = isValidFbReadingAct(ref.act) && isValidFbReadingBusinessId(ref.businessId) &&
    listFbReadingAccounts().some((entry) => entry.act === ref.act)
  if (!known) return Promise.resolve({ ok: false, error: 'invalid-input' })
  // Include the resolved window in the single-flight key so a refresh that
  // crosses midnight can never join (or be refused as duplicate of) a call
  // for a different date window.
  const key = `${ref.act}:${ref.businessId ?? ''}:${range}:${expected.start}:${expected.end}`
  if (boardRefresh) {
    return boardRefresh.key === key ? boardRefresh.result : Promise.resolve({ ok: false, error: 'browser-busy' })
  }
  const control: BoardReadControl = {
    queueDeadline: Date.now() + BOARD_READ_QUEUE_BUDGET_MS,
    deadline: Date.now() + BOARD_READ_TOTAL_BUDGET_MS,
    assertActive() {
      assertBoardReadActive(this)
    }
  }
  const result = withBrowserActionLock<FbReadingRefreshResult>(async () => {
    const startedAt = Date.now()
    try {
      // Queued behind a chat tool or another module for too long: skip
      // without touching the browser instead of fighting over the panel.
      if (Date.now() > control.queueDeadline) return { ok: false, error: 'browser-busy' }
      assertBoardReadActive(control)
      const nav = await runAction({
        action: 'navigate',
        url: buildFbReadingUrlForRef(ref, range, today),
        keepRoute: true,
        background: true,
        // Bounded by loadBrowserPanelUrl's own stop() cleanup; never more
        // than what the total budget still allows.
        navTimeoutMs: Math.max(5_000, Math.min(45_000, control.deadline - Date.now()))
      })
      if (!nav.ok) return { ok: false, error: nav.error }
      assertBoardReadActive(control)
      const page = currentPage(false)
      if (fbLoginWall(page)) return { ok: false, error: 'login-required' }
      panelOwner = 'board-reading'
      latestSnapshotBySession.clear()
      // Read the page as-is first: many column views (e.g. the AND
      // account) already mount a parseable prefix at full stretch, and a
      // reload can cost 30s+ of blank-table time on slow networks. Only
      // when that read is unverified or lacks CTR/installs/impressions do we reload
      // inside the stretch and read again for the wide columns.
      const readVerified = async (): Promise<
        | { kind: 'ok'; reading: FbAdsCampaignReading; stored: boolean | string }
        | { kind: 'failed'; error: string }
      > => {
        const report = await runAction({ action: 'report', background: true }, undefined, control)
        // Login can surface on a failed report too (mid-read redirect), so
        // the wall check runs BEFORE the ok check; reload would not fix it.
        if (fbLoginWall({ url: report.url ?? '', title: report.title ?? '' })) {
          return { kind: 'failed', error: 'login-required' }
        }
        if (!report.ok) return { kind: 'failed', error: report.error }
        if (!report.verified || !report.reading) return { kind: 'failed', error: 'unverified-reading' }
        return { kind: 'ok', reading: report.reading, stored: report.stored ?? 'no-flag' }
      }
      const first = await readVerified()
      const loginOrPageFail =
        first.kind === 'failed' && (first.error === 'login-required' || first.error === 'page-load-failed')
      const rich =
        first.kind === 'ok' &&
        first.reading.rows.some((row) => row.ctr !== null || row.installs !== null || row.impressions !== null)
      let attempt = first
      // iOS (and other virtualized column views) often parse nothing until
      // the table is stretched and reloaded. Do that once inside this call;
      // renderer retry still covers a later unparseable-page. Login/page-load
      // failures skip the reload — it would only repeat them.
      if (!rich && !loginOrPageFail) {
        const widePanel = getActiveBrowserPanel()
        if (widePanel && !widePanel.webContents.isDestroyed()) {
          await withBrowserReadingViewport(widePanel, async () => {
            widePanel.webContents.reload()
            await waitForLoad(20_000, false)
            assertBoardReadActive(control)
            // Second parse stays inside this stretch (report is reentrant)
            // so the table never remounts at the placeholder's narrow size.
            const second = await readVerified()
            if (second.kind === 'ok' || attempt.kind === 'failed') attempt = second
          })
        } else {
          assertBoardReadActive(control)
          const second = await readVerified()
          if (second.kind === 'ok' || attempt.kind === 'failed') attempt = second
        }
      }
      if (attempt.kind === 'failed') return { ok: false, error: attempt.error }
      assertBoardReadActive(control)
      if (!fbReadingMatchesWindow(attempt.reading, ref.act, expected)) return { ok: false, error: 'date-mismatch' }
      const entry = listFbReadings(ref.act).find((e) =>
        Date.parse(e.capturedAt) >= startedAt && fbReadingMatchesWindow(e, ref.act, expected)
      )
      return entry
        ? { ok: true, entry }
        : { ok: false, error: 'not-stored:' + (typeof attempt.stored === 'string' ? attempt.stored : 'find-failed') }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return { ok: false, error: message.match(/ERR_[A-Z_]+/)?.[0] ??
        (['navigation-timeout', 'panel-hidden', 'panel-not-open', 'refresh-timeout'].includes(message) ? message : 'refresh-failed') }
    }
  }).finally(() => {
    // Clear only our own slot: a newer call may already own boardRefresh.
    if (boardRefresh?.result === result) boardRefresh = null
  })
  boardRefresh = { key, result }
  return result
}

interface FbBalanceReadOnce {
  parse: FbAccountBalanceParseResult
}

/**
 * Refresh one ad account's Account Overview available spend. Navigation and
 * DOM reads are read-only; the parser must identify both the account and the
 * labeled spend-limit/spend pair, and two stable reads must agree.
 */
export function refreshFbAccountBalance(ref: FbReadingAccountRef): Promise<FbAccountBalanceRefreshResult> {
  if (balanceRefresh) {
    return balanceRefresh.key === ref.act ? balanceRefresh.result : Promise.resolve({ ok: false, error: 'browser-busy' })
  }
  const known =
    isValidFbReadingAct(ref.act) &&
    isValidFbReadingBusinessId(ref.businessId) &&
    listFbReadingAccounts().some((entry) => entry.act === ref.act)
  if (!known) return Promise.resolve({ ok: false, error: 'invalid-input' })

  const result = withBrowserActionLock<FbAccountBalanceRefreshResult>(async () => {
    const targetUrl = buildFbAccountOverviewUrlForRef(ref)
    try {
      let navigationError: string | null = null
      try {
        const nav = await runAction({ action: 'navigate', url: targetUrl, keepRoute: true, background: true, navTimeoutMs: 45_000 })
        if (!nav.ok) navigationError = nav.error
      } catch (error) {
        // Account Overview can run a redirect chain; continue only when the
        // panel visibly landed on the expected route or Meta's reauth gate.
        navigationError = error instanceof Error ? error.message : 'navigation-failed'
      }
      await waitForLoad(20_000, false)
      const landing = currentPage(false)
      if (fbReauthWall(landing)) return { ok: false, error: '2fa-required' }
      if (fbLoginWall(landing)) return { ok: false, error: 'login-required' }
      const onAccountOverview = /adsmanager\.facebook\.com\/adsmanager\/manage\/accounts/i.test(landing.url)
      if (navigationError !== null && !onAccountOverview) {
        return { ok: false, error: navigationError.match(/ERR_[A-Z_]+/)?.[0] ?? 'navigation-failed' }
      }

      panelOwner = 'fb-account-balance'
      latestSnapshotBySession.clear()
      const readOnce = async (): Promise<FbReadOnce<FbBalanceReadOnce>> => {
        const snap = await exec<{ url: string; title: string; text: string }>(SNAPSHOT_SCRIPT, false)
        const text = snap.text.slice(0, MAX_TEXT_CHARS)
        if (isFacebookSnapshotUrl(snap.url)) {
          try {
            appendFbSnapshot({ url: snap.url, title: snap.title, text })
          } catch {
            // Evidence archival is advisory.
          }
        }
        return { url: snap.url, title: snap.title, text, reading: { parse: parseFbAccountBalanceSnapshot({ ...snap, text, observedAt: Date.now() }, ref.act) } }
      }
      const rejectionOf = (read: FbBalanceReadOnce) =>
        read.parse.kind === 'ok' ? null : read.parse.kind
      const stable = await readStableFbReading(readOnce, rejectionOf, { firstAttempts: 12, secondAttempts: 3 })
      if (!stable.ok) {
        if (fbReauthWall(stable.last)) return { ok: false, error: '2fa-required' }
        if (fbLoginWall(stable.last)) return { ok: false, error: 'login-required' }
        return { ok: false, error: stable.error }
      }
      if (stable.first.reading.parse.kind !== 'ok' || stable.second.reading.parse.kind !== 'ok') {
        return { ok: false, error: 'unparseable-balance-page' }
      }
      const first = stable.first.reading.parse.balance
      const second = stable.second.reading.parse.balance
      if (
        first.accountId !== second.accountId ||
        first.kind !== second.kind ||
        first.amount !== second.amount ||
        first.currency !== second.currency
      ) return { ok: false, error: 'unstable-balance' }
      const entry = saveFbAccountBalance(second)
      return { ok: true, balance: entry }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return {
        ok: false,
        error:
          message.match(/ERR_[A-Z_]+/)?.[0] ??
          (['navigation-timeout', 'panel-hidden', 'panel-not-open'].includes(message) ? message : 'balance-refresh-failed')
      }
    }
  }).finally(() => { balanceRefresh = null })
  balanceRefresh = { key: ref.act, result }
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
