import { describe, expect, it } from 'vitest'
import { HistorySessionDescriptor, Session } from '@shared/types'
import {
  recordsForWorkspace,
  replaceHistoricalSessionRecords,
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
})
