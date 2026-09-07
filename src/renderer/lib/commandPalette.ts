import { basename } from './path'

/**
 * Pure model for the global ⌘K command palette. Nothing here touches the
 * store or React: `buildPaletteItems` assembles the flat item list from plain
 * data the caller shapes out of the store, and `filterPaletteItems` scores
 * and orders it. That keeps the ranking behavior unit-testable and lets the
 * UI component stay a dumb renderer over a filtered list.
 */

/** Where an item renders: fixed group order is 页面 → 操作 → 会话 → 任务. */
export type PaletteItemKind = 'page' | 'action' | 'session' | 'task'

/**
 * What executing an item does. The palette itself performs no effects — App
 * owns every handler (router navigation, store mutations, IPC) and receives
 * these descriptors from the component.
 */
export type PaletteExec =
  | { type: 'navigate'; path: string }
  | { type: 'newChat' }
  | { type: 'toggleTheme' }
  | { type: 'exportHtml'; sessionId: string }
  | { type: 'openSession'; sessionId: string }
  /** Durable history row: resolved Main-side by uuid (see App.openHistoryRecord). */
  | { type: 'openHistory'; uuid: string; cwd: string }

export interface PaletteItem {
  id: string
  kind: PaletteItemKind
  /** Display label and primary search text (already localized). */
  title: string
  /** Extra searchable text (route paths, project folders). Case-insensitive. */
  keywords?: string
  /** Session rows only: project folder suffix shown in the hint column. */
  projectName?: string
  /** Session rows only: epoch ms — recency ordering + relative-time hint. */
  timestamp?: number
  exec: PaletteExec
}

// --- plain-data sources the caller (CommandPalette.tsx) shapes from the store

export interface PalettePageSource {
  id: string
  /** Router path the item navigates to. */
  path: string
  title: string
}

export interface PaletteActionSource {
  id: 'newChat' | 'toggleTheme' | 'exportHtml'
  title: string
  /** exportHtml only: the active session to export. */
  sessionId?: string
}

/**
 * One session row candidate. `origin` mirrors the sidebar's three row kinds
 * and doubles as the open-preference rank when deduping resume forks:
 * live (0) beats workspace capability history (1) beats the cross-project
 * durable scan (2).
 */
export interface PaletteSessionSource {
  origin: 'live' | 'history' | 'global'
  /** live: runtime id · history: opaque capability id · global: durable uuid. */
  id: string
  /** Durable uuid when known — the dedupe key against live rows. */
  uuid: string | null
  title: string
  timestamp: number
  /** Project folder (cwd); the UI renders its basename. */
  cwd: string
  /** Matches the sidebar's archive key (durable uuid, else runtime id). */
  archived: boolean
}

export interface PaletteTaskSource {
  id: string
  name: string
  /** Optional keyword source: the project folder the task runs in. */
  cwd?: string
}

export interface PaletteBuildDeps {
  pages: PalettePageSource[]
  /** Availability is the caller's concern (exportHtml only with an active session). */
  actions: PaletteActionSource[]
  /** Raw live + workspace-history + global-row candidates, already merged. */
  sessions: PaletteSessionSource[]
  tasks: PaletteTaskSource[]
  /** Localized fallback for the 'Untitled' durable-row title. */
  untitledLabel: string
}

// --- scoring ---------------------------------------------------------------

const SCORE_EXACT = 100
const SCORE_PREFIX = 80
const SCORE_WORD_PREFIX = 70
const SCORE_SUBSTRING = 40
const SCORE_KEYWORD = 20

/**
 * Case-insensitive ranked match: exact title tops, then a title prefix, then
 * a prefix of any word inside the title ("会" matching 新建会话's second
 * word), then a plain substring, then keywords. -1 = no match.
 */
export function scorePaletteItem(item: PaletteItem, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return 0
  const title = item.title.toLowerCase()
  if (title === query) return SCORE_EXACT
  if (title.startsWith(query)) return SCORE_PREFIX
  const words = title.split(/[\s\-_/·、，,.]+/).filter(Boolean)
  if (words.some((word) => word.startsWith(query))) return SCORE_WORD_PREFIX
  if (title.includes(query)) return SCORE_SUBSTRING
  if (item.keywords && item.keywords.toLowerCase().includes(query)) return SCORE_KEYWORD
  return -1
}

// --- build -------------------------------------------------------------------

const OPEN_PREFERENCE_RANK: Record<PaletteSessionSource['origin'], number> = {
  live: 0,
  history: 1,
  global: 2
}

/** Sessions shown under an empty query (pages + actions stay complete). */
export const PALETTE_RECENT_SESSIONS_LIMIT = 5
/** Upper bound on rendered rows for a non-empty query. */
export const PALETTE_MAX_RESULTS = 30
/** Two rows within a minute sharing project+title are resume-fork twins. */
const TWIN_WINDOW_MS = 60_000

/**
 * Assemble the flat palette item list: pages, actions, deduped sessions
 * (recency first), then scheduled tasks. Session dedupe mirrors the sidebar's
 * "最近" list — archived rows never appear, durable rows whose uuid a live
 * session owns are hidden, workspace-history rows hide matching global rows,
 * and resume-fork twins collapse to the row that can be opened in place.
 */
export function buildPaletteItems(deps: PaletteBuildDeps): PaletteItem[] {
  const pageItems: PaletteItem[] = deps.pages.map((page) => ({
    id: `page:${page.id}`,
    kind: 'page',
    title: page.title,
    keywords: page.path,
    exec: { type: 'navigate', path: page.path }
  }))

  const actionItems: PaletteItem[] = deps.actions.map((action) => ({
    id: `action:${action.id}`,
    kind: 'action',
    title: action.title,
    exec:
      action.id === 'newChat'
        ? { type: 'newChat' }
        : action.id === 'toggleTheme'
          ? { type: 'toggleTheme' }
          : { type: 'exportHtml', sessionId: action.sessionId ?? '' }
  }))

  // Partition + drop: archived rows, and durable rows whose uuid a live row
  // already owns (resumed sessions surface as their live row only).
  const liveUuids = new Set(
    deps.sessions
      .filter((s) => s.origin === 'live' && s.uuid)
      .map((s) => s.uuid as string)
  )
  const candidates = deps.sessions.filter(
    (s) => !s.archived && (s.origin === 'live' || !s.uuid || !liveUuids.has(s.uuid))
  )
  const historyUuids = new Set(
    candidates.filter((s) => s.origin === 'history' && s.uuid).map((s) => s.uuid as string)
  )
  const scoped = candidates.filter(
    (s) => s.origin !== 'global' || !s.uuid || !historyUuids.has(s.uuid)
  )

  // Resume-fork twins: prefer the row that opens in place (live > history >
  // global) rather than showing near-identical rows seconds apart.
  const kept: PaletteSessionSource[] = []
  const byPreference = [...scoped].sort(
    (a, b) => OPEN_PREFERENCE_RANK[a.origin] - OPEN_PREFERENCE_RANK[b.origin]
  )
  for (const entry of byPreference) {
    const twin = kept.find(
      (candidate) =>
        (basename(candidate.cwd) || candidate.cwd) === (basename(entry.cwd) || entry.cwd) &&
        candidate.title === entry.title &&
        Math.abs(candidate.timestamp - entry.timestamp) < TWIN_WINDOW_MS
    )
    if (!twin) {
      kept.push(entry)
      continue
    }
    if (OPEN_PREFERENCE_RANK[entry.origin] < OPEN_PREFERENCE_RANK[twin.origin]) {
      kept[kept.indexOf(twin)] = entry
    }
  }
  kept.sort((a, b) => b.timestamp - a.timestamp)

  const sessionItems: PaletteItem[] = kept.map((session) => ({
    id: `session:${session.origin}:${session.id}`,
    kind: 'session',
    title: session.title === 'Untitled' ? deps.untitledLabel : session.title,
    keywords: [session.cwd, session.uuid ?? ''].filter(Boolean).join(' '),
    projectName: basename(session.cwd) || session.cwd,
    timestamp: session.timestamp,
    exec:
      session.origin === 'live'
        ? { type: 'openSession', sessionId: session.id }
        : { type: 'openHistory', uuid: session.uuid ?? session.id, cwd: session.cwd }
  }))

  const taskItems: PaletteItem[] = deps.tasks.map((task) => ({
    id: `task:${task.id}`,
    kind: 'task',
    title: task.name,
    keywords: task.cwd,
    exec: { type: 'navigate', path: '/tasks' }
  }))

  return [...pageItems, ...actionItems, ...sessionItems, ...taskItems]
}

// --- filter ------------------------------------------------------------------

/**
 * Empty query: the landing view — every page and action plus a few recent
 * sessions. Scheduled tasks are command-like and only surface on a query.
 * Non-empty query: ranked matches (see scorePaletteItem), score descending;
 * equal scores order sessions by recency and keep the build order otherwise.
 */
export function filterPaletteItems(items: PaletteItem[], rawQuery: string): PaletteItem[] {
  const query = rawQuery.trim()
  if (!query) {
    const recentSessions = items
      .filter((item) => item.kind === 'session')
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, PALETTE_RECENT_SESSIONS_LIMIT)
    return [
      ...items.filter((item) => item.kind === 'page'),
      ...items.filter((item) => item.kind === 'action'),
      ...recentSessions
    ]
  }
  const scored: Array<{ item: PaletteItem; score: number }> = []
  for (const item of items) {
    const score = scorePaletteItem(item, query)
    if (score >= 0) scored.push({ item, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.item.timestamp !== undefined && b.item.timestamp !== undefined) {
      return b.item.timestamp - a.item.timestamp
    }
    return 0
  })
  return scored.slice(0, PALETTE_MAX_RESULTS).map((entry) => entry.item)
}
