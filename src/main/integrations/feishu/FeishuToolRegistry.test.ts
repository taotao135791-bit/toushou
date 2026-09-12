import { withUserAccessToken } from '@larksuiteoapi/node-sdk'
import { describe, expect, it, vi } from 'vitest'
import { FeishuToolRegistry, SessionToolBreaker, capabilityFor } from './FeishuToolRegistry'

describe('FeishuToolRegistry', () => {
  it('keeps message tools on the app channel and maps document access correctly', () => {
    expect(capabilityFor('message_read')).toBe('messaging')
    // /search/v2/message only accepts user tokens — search is its own
    // capability so the pre-flight authorization gate can refuse doomed
    // tenant-token calls (they fail with an opaque 400 the agent retries).
    expect(capabilityFor('message_search')).toBe('search')
    expect(capabilityFor('doc_read')).toBe('docs.read')
    expect(capabilityFor('doc_append')).toBe('docs.write')
    expect(capabilityFor('doc_list')).toBe('drive')
    expect(capabilityFor('doc_search')).toBe('drive')
  })

  it('refuses message search without the search capability instead of firing a tenant-token call', async () => {
    const request = vi.fn()
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      (capability) => capability === 'messaging',
      async () => null
    )
    const result = await registry.execute({ action: 'message_search', query: '投手' })
    expect(result.ok).toBe(false)
    expect(result.authorizationRequired).toBe('search')
    expect(result.error).toContain('[[connect:feishu]]')
    expect(request).not.toHaveBeenCalled()
  })

  it('sends message search with the search capability user token', async () => {
    const request = vi.fn(async () => ({ code: 0, data: { entities: [] } }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async (capability) => capability === 'search' ? 'search-token' : null
    )
    await expect(registry.execute({ action: 'message_search', query: '投手' })).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', url: '/open-apis/search/v2/message' }),
      withUserAccessToken('search-token')
    )
  })

  it('rejects empty ids and queries before any network call', async () => {
    const request = vi.fn()
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'token'
    )
    await expect(registry.execute({ action: 'message_read', messageId: '  ' })).resolves.toMatchObject({ ok: false, error: 'messageId 不能为空' })
    await expect(registry.execute({ action: 'message_search', query: '' })).resolves.toMatchObject({ ok: false, error: 'query 不能为空' })
    await expect(registry.execute({ action: 'doc_read', documentId: undefined })).resolves.toMatchObject({ ok: false, error: 'documentId 不能为空' })
    await expect(registry.execute({ action: 'doc_search', query: ' ' })).resolves.toMatchObject({ ok: false, error: 'query 不能为空' })
    await expect(registry.execute({ action: 'bitable_read', appToken: 'app', tableId: '' })).resolves.toMatchObject({ ok: false, error: 'appToken 和 tableId 不能为空' })
    expect(request).not.toHaveBeenCalled()
  })

  it('marks permission-class API errors with the connect guide', async () => {
    const request = vi.fn(async () => ({ code: 99991663, msg: 'invalid access token for authorization' }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'stale-token'
    )
    const result = await registry.execute({ action: 'doc_read', documentId: 'doc_1' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('[[connect:feishu]]')
  })

  it('marks 401/403 transport failures with the connect guide', async () => {
    const request = vi.fn(async () => { throw new Error('Request failed with status code 401') })
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'revoked-token'
    )
    const result = await registry.execute({ action: 'doc_read', documentId: 'doc_1' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('[[connect:feishu]]')
  })

  it('passes user OAuth tokens only to user-scoped API requests', async () => {
    const request = vi.fn(async () => ({ code: 0, data: { title: 'brief' } }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async (capability) => capability === 'docs.read' ? 'user-token' : null
    )
    await expect(registry.execute({ action: 'doc_read', documentId: 'doc_1' })).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/open-apis/docx/v1/documents/doc_1/raw_content' }),
      withUserAccessToken('user-token')
    )
  })

  it('lists recent drive files with the drive capability token', async () => {
    const request = vi.fn(async () => ({ code: 0, data: { files: [{ name: 'a', token: 't' }] } }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async (capability) => capability === 'drive' ? 'drive-token' : null
    )
    await expect(registry.execute({ action: 'doc_list' })).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/open-apis/drive/v1/files',
        params: expect.objectContaining({ order_by: 'EditedTime', direction: 'DESC' })
      }),
      withUserAccessToken('drive-token')
    )
  })

  it('searches docs with a bounded keyword', async () => {
    const request = vi.fn(async () => ({ code: 0, data: { entities: [] } }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'drive-token'
    )
    await expect(registry.execute({ action: 'doc_search', query: '  投放  ' })).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/open-apis/suite/docs-api/search/object',
        data: { search_key: '投放', count: 20, offset: 0 }
      }),
      withUserAccessToken('drive-token')
    )
  })

  it('pauses a session after repeated hard failures via executeForSession', async () => {
    const request = vi.fn(async () => { throw new Error('Request failed with status code 400') })
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'token'
    )
    for (let i = 0; i < 5; i++) {
      await expect(registry.executeForSession('s1', { action: 'doc_read', documentId: 'doc_1' })).resolves.toMatchObject({ ok: false })
    }
    // Tripped: the next call is refused before touching the network.
    const blocked = await registry.executeForSession('s1', { action: 'doc_read', documentId: 'doc_1' })
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain('暂时停止调用')
    expect(blocked.error).toContain('[[connect:feishu]]')
    const callsAfterTripped = request.mock.calls.length
    await registry.executeForSession('s1', { action: 'doc_read', documentId: 'doc_1' })
    expect(request.mock.calls.length).toBe(callsAfterTripped)
    // Parameter mistakes alone never trip the breaker for another session.
    for (let i = 0; i < 8; i++) {
      await registry.executeForSession('s2', { action: 'doc_read', documentId: '' })
    }
    const s2 = await registry.executeForSession('s2', { action: 'doc_read', documentId: 'doc_1' })
    expect(s2.error).not.toContain('暂时停止调用')
  })
})

describe('SessionToolBreaker', () => {
  it('resets the failure streak on success and expires the pause after the cooldown', () => {
    let now = 1_000_000
    const breaker = new SessionToolBreaker(2, 1_000, () => now)
    expect(breaker.check('s')).toBeNull()
    breaker.note('s', { ok: false, error: 'boom' })
    // Model-fixable parameter mistakes are not counted.
    breaker.note('s', { ok: false, error: 'query 不能为空' })
    expect(breaker.check('s')).toBeNull()
    breaker.note('s', { ok: false, error: 'boom' })
    const blocked = breaker.check('s')
    expect(blocked?.ok).toBe(false)
    // Cooldown elapses → calls flow again.
    now += 1_001
    expect(breaker.check('s')).toBeNull()
    // A success clears the streak.
    breaker.note('s', { ok: false, error: 'boom' })
    breaker.note('s', { ok: true })
    breaker.note('s', { ok: false, error: 'boom' })
    expect(breaker.check('s')).toBeNull()
  })
})
