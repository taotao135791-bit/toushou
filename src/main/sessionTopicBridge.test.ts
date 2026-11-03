import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchSessionTopic, initSessionTopicBridge, parseSessionTopicRequest, resetSessionTopicBridgeForTest, sessionTopicBridgeEnv } from './sessionTopicBridge'

afterEach(resetSessionTopicBridgeForTest)
function fixture() {
  const nameSession = vi.fn(async (_id: string, _title: string, _opts: unknown) => ({ title: 'TikTok成本诊断', source: 'auto' as const, revision: 3 }))
  return { getSession: (id: string) => id === 'a' ? { title: '初始主题' } : undefined, getRevision: () => 3, nameSession }
}

describe('session-bound topic metadata bridge', () => {
  it('validates bounded names and exact nonnegative integer revisions', () => {
    expect(parseSessionTopicRequest({ action: 'context' })).toEqual({ action: 'context' })
    for (const value of [null, [], { action: 'topic', title: '', revision: 1 }, { action: 'topic', title: 'x'.repeat(241), revision: 1 }, { action: 'topic', title: '名称', revision: -1 }, { action: 'topic', title: '名称', revision: 1.1 }]) expect(parseSessionTopicRequest(value)).toBeNull()
  })

  it('gets only the calling session context and refuses a stale model result', async () => {
    const deps = fixture()
    await expect(dispatchSessionTopic(deps, 'a', { action: 'context' })).resolves.toEqual({ ok: true, revision: 3, manual: false })
    await expect(dispatchSessionTopic(deps, 'a', { action: 'topic', title: '旧主题', revision: 2 })).resolves.toEqual({ ok: false, error: 'stale-topic' })
    await expect(dispatchSessionTopic(deps, 'missing', { action: 'context' })).resolves.toEqual({ ok: false, error: 'no-session' })
    expect(deps.nameSession).not.toHaveBeenCalled()
  })

  it('never reflects arbitrary exceptions, credentials or provider messages', async () => {
    const deps = fixture()
    deps.nameSession.mockRejectedValue(new Error('sk-syntheticSensitiveError123'))
    await expect(dispatchSessionTopic(deps, 'a', { action: 'topic', title: '诊断', revision: 3 })).resolves.toEqual({ ok: false, error: 'topic-unavailable' })
  })

  it('uses the token-bound session even if input asks for another session or file', async () => {
    const deps = fixture()
    await initSessionTopicBridge(deps)
    const endpoint = sessionTopicBridgeEnv('a').TOUSHOU_SESSION_TOPIC
    const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ action: 'topic', title: '诊断', revision: 3, sessionId: 'b', file: '/synthetic/untrusted' }) })
    expect(await response.json()).toMatchObject({ ok: true })
    expect(deps.nameSession).toHaveBeenCalledOnce()
    expect(deps.nameSession).toHaveBeenCalledWith('a', '诊断', { source: 'auto', revision: 3 })
  })

  it('denies unknown/revoked tokens, oversized bodies and dead sessions', async () => {
    const deps = fixture()
    await initSessionTopicBridge(deps)
    const old = sessionTopicBridgeEnv('a').TOUSHOU_SESSION_TOPIC
    const endpoint = sessionTopicBridgeEnv('a').TOUSHOU_SESSION_TOPIC
    expect((await fetch(old, { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await fetch(endpoint, { method: 'POST', body: 'x'.repeat(2049) })).status).toBe(413)
    const missing = sessionTopicBridgeEnv('missing').TOUSHOU_SESSION_TOPIC
    const response = await fetch(missing, { method: 'POST', body: JSON.stringify({ action: 'context' }) })
    expect(await response.json()).toEqual({ ok: false, error: 'no-session' })
  })

  it('does not expose a manually entered name in the model metadata context', async () => {
    const deps = { ...fixture(), getSession: () => ({ title: 'private manual name', titleSource: 'manual' as const }) }
    await expect(dispatchSessionTopic(deps, 'a', { action: 'context' })).resolves.toEqual({ ok: true, revision: 3, manual: true })
  })
})
