import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { sidebarConversations } from './sidebarConversations'
import type { SessionRecord } from './sessionRegistry'

describe('sidebar conversation identity', () => {
  const history = { id: 'cap-1', uuid: 'durable-a', title: 'Same title', timestamp: 100 }
  const record: SessionRecord = { key: 'old-cap-key', workspaceRealPath: '/project/a', title: history.title, history, updatedAt: 100, isLive: false, isResumable: true, state: 'historical' }
  const input = { sessions: [] as Session[], records: [record], globalHistory: [{ ...history, cwd: '/project/a' }], currentPath: '/project/a', archivedProjects: new Set<string>(), pinned: new Set<string>() }
  it('keeps a durable key through capability refresh and cross-project projection', () => {
    const initial = sidebarConversations(input)
    const refreshed = sidebarConversations({ ...input, records: [{ ...record, history: { ...history, id: 'new-cap' } }] })
    const switched = sidebarConversations({ ...input, currentPath: '/project/b' })
    expect(initial).toHaveLength(1)
    expect(initial[0].kind).toBe('history')
    expect(refreshed[0].key).toBe(initial[0].key)
    expect(switched[0].kind).toBe('global')
    expect(switched[0].key).toBe(initial[0].key)
  })
  it('keeps distinct same-title conversations and scopes UUIDs by canonical project', () => {
    const result = sidebarConversations({ ...input, globalHistory: [...input.globalHistory, { ...history, uuid: 'durable-b', cwd: '/project/a' }, { ...history, cwd: '/project/b' }] })
    expect(result).toHaveLength(3)
    expect(new Set(result.map(row => row.key)).size).toBe(3)
  })
  it('uses the first runtime record when duplicate records exist', () => {
    const live = {id:'live',cwd:'/project/a',title:'Live',createdAt:100,status:'idle'} as Session
    const first = {...record, runtimeSessionId:'live', isLive:true}
    const second = {...first, key:'second', history:{...history, uuid:'durable-b'}}
    const rows = sidebarConversations({...input, sessions:[live], records:[first, second], globalHistory:[...input.globalHistory, {...history, uuid:'durable-b', cwd:'/project/a'}]})
    expect(rows.map(row => row.kind)).toEqual(['live', 'global'])
    expect(rows[0].key).toBe(JSON.stringify(['/project/a', 'durable-a']))
  })
  it('prefers the existing runtime and hides archived project conversations', () => {
    const live = { id: 'live', cwd: '/project/a', title: 'Live title', createdAt: 100, status: 'idle' } as Session
    const result = sidebarConversations({ ...input, sessions: [live], records: [{ ...record, runtimeSessionId: 'live', isLive: true }], pinned: new Set(['live']) })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: 'live', pinned: true, title: 'Live title' })
    expect(sidebarConversations({ ...input, archivedProjects: new Set(['/project/a']) })).toEqual([])
  })
})
