import type { HistorySessionDescriptor, HistorySessionRow, Session } from '@shared/types'
import { recordDurableUuid, sessionFileUuid, type SessionRecord } from './sessionRegistry'
import { basename } from './path'

export type SidebarConversation = {
  key: string
  workspacePath: string
  timestamp: number
  title: string
  pinned: boolean
  projectName: string
} & (
  | { kind: 'live'; session: Session }
  | { kind: 'history'; info: HistorySessionDescriptor }
  | { kind: 'global'; row: HistorySessionRow }
)

/** Runtime, opaque capability and global scan are views of one durable identity. */
export function sidebarConversations(input: {
  sessions: Session[]
  records: SessionRecord[]
  globalHistory: HistorySessionRow[]
  currentPath: string | null
  archivedProjects: ReadonlySet<string>
  pinned: ReadonlySet<string>
}): SidebarConversation[] {
  const entries = new Map<string, SidebarConversation>()
  const identity = (workspace: string, uuid: string) => JSON.stringify([workspace, uuid])
  const add = (entry: SidebarConversation) => {
    if (!input.archivedProjects.has(entry.workspacePath) && !entries.has(entry.key)) entries.set(entry.key, entry)
  }
  const recordByRuntimeId = new Map<string, SessionRecord>()
  for (const record of input.records) {
    if (typeof record.runtimeSessionId === 'string' && !recordByRuntimeId.has(record.runtimeSessionId)) recordByRuntimeId.set(record.runtimeSessionId, record)
  }
  for (const session of input.sessions) {
    const record = recordByRuntimeId.get(session.id)
    const uuid = recordDurableUuid(record) ?? sessionFileUuid(session.resumeFrom ?? session.sessionFile)
    add({ kind: 'live', key: identity(session.cwd, uuid ?? `runtime:${session.id}`), workspacePath: session.cwd,
      timestamp: session.lastActivityAt ?? session.createdAt, title: session.title, pinned: input.pinned.has(session.id), projectName: basename(session.cwd) || session.cwd, session })
  }
  for (const record of input.records) {
    if (record.isLive || !record.history || record.workspaceRealPath !== input.currentPath) continue
    const info = record.history
    add({ kind: 'history', key: identity(record.workspaceRealPath, info.uuid), workspacePath: record.workspaceRealPath,
      timestamp: info.timestamp, title: info.title, pinned: false, projectName: basename(record.workspaceRealPath), info })
  }
  for (const row of input.globalHistory) {
    add({ kind: 'global', key: identity(row.cwd, row.uuid), workspacePath: row.cwd,
      timestamp: row.timestamp, title: row.title, pinned: false, projectName: basename(row.cwd) || row.cwd, row })
  }
  return [...entries.values()]
}
