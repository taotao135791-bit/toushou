import { HistorySessionDescriptor, Session, SessionSortOrder } from '@shared/types'

/** The single renderer projection used to reason about live and historical sessions. */
export type SessionRecordState = 'idle' | 'running' | 'waiting' | 'dead' | 'historical'

export interface SessionRecord {
  /** Opaque durable-history identity when available; otherwise the live runtime id. */
  key: string
  workspaceRealPath: string
  title: string
  runtimeSessionId?: string
  sessionFile?: string
  history?: HistorySessionDescriptor
  state: SessionRecordState
  createdAt?: number
  updatedAt: number
  isLive: boolean
  isResumable: boolean
}

function sessionFileOf(session: Session): string | undefined {
  return session.resumeFrom ?? session.sessionFile
}

function liveState(session: Session): SessionRecordState {
  return session.status === 'error' ? 'dead' : 'idle'
}

function sameHistory(record: SessionRecord, info: HistorySessionDescriptor): boolean {
  return (
    record.history?.id === info.id ||
    // A history refresh mints a new opaque id. A live session that came from
    // the same durable UUID retains its row without needing the private path.
    (record.isLive && Boolean(info.uuid) && record.history?.uuid === info.uuid)
  )
}

function liveMatch(record: SessionRecord, session: Session): boolean {
  const sessionFile = sessionFileOf(session)
  return (
    record.runtimeSessionId === session.id ||
    (Boolean(session.resumedHistoryId) && record.history?.id === session.resumedHistoryId) ||
    (Boolean(sessionFile) && record.sessionFile === sessionFile)
  )
}

/** Insert/update a live session without creating a duplicate live row for its durable file. */
export function upsertLiveSessionRecord(
  records: SessionRecord[],
  session: Session,
  now = Date.now()
): SessionRecord[] {
  const sessionFile = sessionFileOf(session)
  const index = records.findIndex((record) => liveMatch(record, session))
  const previous = index >= 0 ? records[index] : undefined
  const record: SessionRecord = {
    key: sessionFile ?? previous?.key ?? `runtime:${session.id}`,
    workspaceRealPath: session.cwd,
    title: session.title || previous?.title || 'New Chat',
    runtimeSessionId: session.id,
    ...(sessionFile ? { sessionFile } : previous?.sessionFile ? { sessionFile: previous.sessionFile } : {}),
    ...(previous?.history ? { history: previous.history } : {}),
    state: liveState(session),
    createdAt: session.createdAt || previous?.createdAt,
    updatedAt: now,
    isLive: true,
    isResumable: Boolean(sessionFile || previous?.history)
  }
  const next = records.filter((_, i) => i !== index)
  // A file-based key can replace an earlier runtime-only key while preserving
  // ordering. This is the live→durable identity handoff after get_state.
  return [record, ...next.filter((item) => item.key !== record.key)]
}

/** Merge discovery results for one canonical workspace and retain live records. */
export function replaceHistoricalSessionRecords(
  records: SessionRecord[],
  workspaceRealPath: string,
  history: HistorySessionDescriptor[],
  now = Date.now()
): SessionRecord[] {
  const discovered = new Set(history.map((info) => info.id))
  const kept = records.filter(
    (record) =>
      record.isLive ||
      record.workspaceRealPath !== workspaceRealPath ||
      (record.history?.id ? discovered.has(record.history.id) : false)
  )
  let next = kept
  for (const info of history) {
    const index = next.findIndex((record) => sameHistory(record, info))
    const previous = index >= 0 ? next[index] : undefined
    const record: SessionRecord = {
      key: previous?.key ?? `history:${info.id}`,
      workspaceRealPath,
      title: previous?.isLive ? previous.title : info.title,
      ...(previous?.runtimeSessionId ? { runtimeSessionId: previous.runtimeSessionId } : {}),
      ...(previous?.sessionFile ? { sessionFile: previous.sessionFile } : {}),
      history: info,
      state: previous?.isLive ? previous.state : 'historical',
      createdAt: previous?.createdAt ?? info.timestamp,
      updatedAt: now,
      isLive: previous?.isLive ?? false,
      isResumable: true
    }
    next = index >= 0 ? [record, ...next.filter((_, i) => i !== index)] : [record, ...next]
  }
  return next
}

export function updateSessionRecordTitle(
  records: SessionRecord[],
  sessionId: string,
  title: string,
  now = Date.now()
): SessionRecord[] {
  return records.map((record) =>
    record.runtimeSessionId === sessionId ? { ...record, title, updatedAt: now } : record
  )
}

export function updateSessionRecordFile(
  records: SessionRecord[],
  sessionId: string,
  sessionFile: string,
  now = Date.now()
): SessionRecord[] {
  const index = records.findIndex((record) => record.runtimeSessionId === sessionId)
  if (index < 0) return records
  const previous = records[index]
  const updated: SessionRecord = {
    ...previous,
    key: sessionFile,
    sessionFile,
    isResumable: true,
    updatedAt: now
  }
  return [updated, ...records.filter((_, i) => i !== index && records[i].key !== sessionFile)]
}

export function removeLiveSessionRecords(records: SessionRecord[], liveSessionIds: Set<string>): SessionRecord[] {
  return records.filter((record) => !record.isLive || !record.runtimeSessionId || liveSessionIds.has(record.runtimeSessionId))
}

export function removeHistoryRecord(records: SessionRecord[], historyId: string): SessionRecord[] {
  return records.filter((record) => record.history?.id !== historyId || record.isLive)
}

/**
 * Purge a deleted session's durable uuid from the registry across ALL
 * workspaces — capability ids are per-workspace and per-refresh, but the uuid
 * is the durable identity a rescan can resurface. Live records are kept: they
 * own a running process, not just a discovered file.
 */
export function purgeHistoryUuid(records: SessionRecord[], uuid: string): SessionRecord[] {
  if (!uuid) return records
  return records.filter((record) => record.isLive || record.history?.uuid !== uuid)
}

export function recordsForWorkspace(records: SessionRecord[], workspaceRealPath: string | null): SessionRecord[] {
  if (!workspaceRealPath) return []
  return records.filter((record) => record.workspaceRealPath === workspaceRealPath)
}

// --- Sidebar archive + sort helpers (pure) ----------------------------------

const SESSION_FILE_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** Durable uuid embedded in a session file name (`<timestamp>_<uuid>.jsonl`). */
export function sessionFileUuid(sessionFile: string | undefined | null): string | null {
  return SESSION_FILE_UUID.exec(sessionFile ?? '')?.[1] ?? null
}

/**
 * Durable identity of a registry record: the history capability's uuid when
 * known, else the uuid embedded in its session file. The sidebar archive is
 * keyed by this so an entry survives the live→durable handoff — killing an
 * archived live session makes its file resurface as a history row that stays
 * archived under the same key.
 */
export function recordDurableUuid(record: SessionRecord | undefined | null): string | null {
  return record?.history?.uuid ?? sessionFileUuid(record?.sessionFile)
}

/** Structural row the generic sort needs; sidebar entry unions fit as-is. */
export interface SortableSessionRow {
  title: string
  timestamp: number
  /** Pinned rows float to the top under every sort. */
  pinned?: boolean
}

/**
 * Order sidebar rows by the user's sort preference. Non-mutating and stable;
 * pinned rows always come first, 'name' falls back to recency on ties so
 * duplicate/untitled titles keep a deterministic order.
 */
export function sortSessionRows<T extends SortableSessionRow>(
  rows: readonly T[],
  sort: SessionSortOrder
): T[] {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  return [...rows].sort((a, b) => {
    const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    if (pinned !== 0) return pinned
    if (sort === 'name') {
      const byTitle = collator.compare(a.title, b.title)
      if (byTitle !== 0) return byTitle
    }
    return b.timestamp - a.timestamp
  })
}
