import { describe, expect, it } from 'vitest'
import { HistorySessionDescriptor, Session } from '@shared/types'
import {
  purgeHistoryUuid,
  recordsForWorkspace,
  recordDurableUuid,
  replaceHistoricalSessionRecords,
  sessionFileUuid,
  sortSessionRows,
  updateSessionRecordTitle,
  upsertLiveSessionRecord
} from './sessionRegistry'

const A = '/workspace/a'
const B = '/workspace/b'

function live(id: string, cwd = A, extra: Partial<Session> = {}): Session {
  return {
    id,
    cwd,
    title: cwd.endsWith('/a') ? 'Workspace A' : 'Workspace B',
    createdAt: 100,
    status: 'idle',
    ...extra
  }
}

function history(id: string, uuid = id): HistorySessionDescriptor {
  return { id, uuid, title: `History ${uuid}`, timestamp: 200 }
}

describe('session registry projection', () => {
  it('registers a new live session immediately and updates its title in place', () => {
    let records = upsertLiveSessionRecord([], live('a'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ runtimeSessionId: 'a', workspaceRealPath: A, isLive: true })

    records = updateSessionRecordTitle(records, 'a', 'First prompt')
    expect(records).toHaveLength(1)
    expect(records[0].title).toBe('First prompt')
  })

  it('retains A and B as separate live records', () => {
    let records = upsertLiveSessionRecord([], live('a'))
    records = upsertLiveSessionRecord(records, live('b'))
    expect(records.map((record) => record.runtimeSessionId)).toEqual(['b', 'a'])
  })

  it('scopes records by canonical workspace path', () => {
    let records = upsertLiveSessionRecord([], live('a', A))
    records = upsertLiveSessionRecord(records, live('b', B))
    expect(recordsForWorkspace(records, A).map((record) => record.runtimeSessionId)).toEqual(['a'])
    expect(recordsForWorkspace(records, B).map((record) => record.runtimeSessionId)).toEqual(['b'])
  })

  it('upgrades a historical row through its opaque capability, not a file path', () => {
    const info = history('history-a', 'uuid-a')
    let records = replaceHistoricalSessionRecords([], A, [info])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ key: 'history:history-a', state: 'historical', isLive: false, isResumable: true })

    records = upsertLiveSessionRecord(
      records,
      live('runtime-a', A, { resumedHistoryId: info.id, title: info.title })
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      key: 'history:history-a',
      runtimeSessionId: 'runtime-a',
      state: 'idle',
      isLive: true,
      isResumable: true
    })
  })

  it('replaces stale historical discovery without dropping a live session', () => {
    const a = history('history-a', 'uuid-a')
    const b = history('history-b', 'uuid-b')
    let records = replaceHistoricalSessionRecords([], A, [a, b])
    records = upsertLiveSessionRecord(records, live('runtime-a', A, { resumedHistoryId: a.id }))
    const refreshedA = { ...a, id: 'history-a-refreshed' }
    records = replaceHistoricalSessionRecords(records, A, [refreshedA])
    expect(records.filter((record) => record.history).map((record) => record.history?.id)).toEqual(['history-a-refreshed'])
    expect(records.some((record) => record.runtimeSessionId === 'runtime-a' && record.isLive)).toBe(true)
  })

  it('keeps foreign live rows (e.g. Feishu workspace) across another workspace refresh', () => {
    // The Feishu channel creates sessions under the app workspace (B) while
    // the user is working in A: its live row must survive A's history merge
    // and stay scoped to B for the workspace-bound views.
    let records = upsertLiveSessionRecord([], live('feishu-1', B, { origin: 'feishu' }))
    records = upsertLiveSessionRecord(records, live('local-1', A))
    records = replaceHistoricalSessionRecords(records, A, [history('history-a', 'uuid-a')])

    expect(records.filter((record) => record.runtimeSessionId === 'feishu-1')).toHaveLength(1)
    expect(recordsForWorkspace(records, B).map((record) => record.runtimeSessionId)).toEqual(['feishu-1'])
    expect(records.filter((record) => record.workspaceRealPath === A)).toHaveLength(2)
  })

  it('purges a deleted durable uuid across all workspaces but keeps live rows', () => {
    const a = history('history-a', 'uuid-a')
    // The same durable session discovered under a DIFFERENT workspace (its
    // capability id differs per workspace mint, the uuid does not).
    const twin = history('history-a-other-workspace', 'uuid-a')
    let records = replaceHistoricalSessionRecords([], A, [a])
    records = replaceHistoricalSessionRecords(records, B, [twin])
    records = upsertLiveSessionRecord(records, live('runtime-a', A, { resumedHistoryId: a.id }))

    records = purgeHistoryUuid(records, 'uuid-a')
    // Both capability rows for the deleted uuid are gone…
    expect(records.filter((record) => !record.isLive)).toHaveLength(0)
    // …while the live session resumed from it stays.
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ runtimeSessionId: 'runtime-a', isLive: true })

    // Unrelated uuids and empty inputs are no-ops.
    records = purgeHistoryUuid(records, 'uuid-b')
    expect(records).toHaveLength(1)
    expect(purgeHistoryUuid(records, '')).toBe(records)
  })

  it('extracts the durable uuid from session file names and records', () => {
    expect(sessionFileUuid('/store/1700000000000_1b2f6a3c-1111-4222-8333-aabbccddeeff.jsonl')).toBe(
      '1b2f6a3c-1111-4222-8333-aabbccddeeff'
    )
    expect(sessionFileUuid('/store/not-a-session-file.jsonl')).toBeNull()
    expect(sessionFileUuid(undefined)).toBeNull()

    // History capability uuid wins; the file uuid is the fallback.
    const fileOnly = upsertLiveSessionRecord([], live('runtime-a'))
    expect(recordDurableUuid(fileOnly[0])).toBeNull()
    const withFile = upsertLiveSessionRecord(
      [],
      live('runtime-a', A, { sessionFile: '/store/1700000000000_1b2f6a3c-1111-4222-8333-aabbccddeeff.jsonl' })
    )
    expect(recordDurableUuid(withFile[0])).toBe('1b2f6a3c-1111-4222-8333-aabbccddeeff')
    expect(recordDurableUuid(withFile[0])).toBe(sessionFileUuid(withFile[0].sessionFile))
    const withHistory = replaceHistoricalSessionRecords(withFile, A, [history('history-a', 'uuid-a')])
    expect(recordDurableUuid(withHistory[0])).toBe('uuid-a')
    expect(recordDurableUuid(undefined)).toBeNull()
  })

  it('sorts sidebar rows by recency or name, pinned first, without mutating', () => {
    const rows = [
      { key: 'old', title: 'Banana', timestamp: 100 },
      { key: 'pinned-old', title: 'Zebra', timestamp: 50, pinned: true },
      { key: 'new', title: 'cherry', timestamp: 300 },
      { key: 'mid2', title: 'Apple', timestamp: 250 },
      { key: 'mid', title: 'apple', timestamp: 200 }
    ]
    const byRecent = sortSessionRows(rows, 'recent')
    expect(byRecent.map((row) => row.key)).toEqual(['pinned-old', 'new', 'mid2', 'mid', 'old'])
    // Pinned rows float to the top under the name sort too; titles compare
    // case-insensitively and identical titles fall back to recency.
    const byName = sortSessionRows(rows, 'name')
    expect(byName.map((row) => row.key)).toEqual(['pinned-old', 'mid2', 'mid', 'old', 'new'])
    // The input array is untouched.
    expect(rows.map((row) => row.key)).toEqual(['old', 'pinned-old', 'new', 'mid2', 'mid'])
    expect(sortSessionRows([], 'name')).toEqual([])
  })
})
