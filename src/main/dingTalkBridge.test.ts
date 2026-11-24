import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DingTalkReadRequest, DingTalkReadResult } from '../shared/connections'
import registerDingTalkTools from '../../resources/dingtalk-toolkit/extensions/index'

const { read, getSession, getSessionBridgeAccess } = vi.hoisted(() => ({
  read: vi.fn<(tool: DingTalkReadRequest, signal?: AbortSignal) => Promise<DingTalkReadResult>>(),
  getSession: vi.fn<() => { origin?: 'feishu' | 'task' } | undefined>(),
  getSessionBridgeAccess: vi.fn<() => { cwd: string; remoteReadonly: boolean } | null>()
}))

vi.mock('./omp', () => ({ getSession, getSessionBridgeAccess }))
vi.mock('./integrations/dingtalk/DingTalkConnectionManager', () => ({ dingTalkConnectionManager: { read } }))

import { DINGTALK_TOOLS_ENV_KEY, dingTalkBridgeEnv, initDingTalkBridge, parseDingTalkReadRequest, revokeDingTalkBridgeTokens } from './dingTalkBridge'

const session = 'synthetic-dingtalk-session'
const access = { cwd: '/synthetic/project', remoteReadonly: false }
const query: DingTalkReadRequest = { action: 'search_messages', query: '投放复盘' }

async function post(url: string, body: unknown, origin?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body)
  })
}

describe('DingTalk read request validation', () => {
  it('accepts an explicit keyword or an ID and discards query parameters from an official document link', () => {
    expect(parseDingTalkReadRequest({ action: 'search_documents', query: '  滚动预算  ' })).toEqual({ action: 'search_documents', query: '滚动预算' })
    expect(parseDingTalkReadRequest({ action: 'read_document', documentId: 'ABC_123-ab' })).toEqual({ action: 'read_document', documentId: 'ABC_123-ab' })
    expect(parseDingTalkReadRequest({ action: 'read_document', documentId: 'https://alidocs.dingtalk.com/i/nodes/ABC_123-ab?shareId=example' })).toEqual({ action: 'read_document', documentId: 'ABC_123-ab' })
  })

  it.each([
    ['arbitrary commands', { action: 'shell', argv: ['auth', 'token'] }],
    ['profile overrides', { ...query, profile: 'other-tenant' }],
    ['extra arguments', { action: 'read_document', documentId: 'ABC', args: ['--output', '/tmp/local.txt'] }],
    ['empty searches', { action: 'search_documents', query: ' ' }],
    ['control characters', { action: 'search_messages', query: 'bad\nquery' }],
    ['oversized searches', { action: 'search_messages', query: 'a'.repeat(201) }],
    ['arbitrary URLs', { action: 'read_document', documentId: 'https://example.invalid/i/nodes/ABC' }],
    ['password-looking URL authority', { action: 'read_document', documentId: 'https://synthetic@alidocs.dingtalk.com/i/nodes/ABC' }],
    ['foreign URLs with the official host in their paths', { action: 'read_document', documentId: 'https://example.invalid/alidocs.dingtalk.com/i/nodes/ABC' }],
    ['untrusted paths', { action: 'read_document', documentId: '../other-tenant' }]
  ])('rejects %s', (_label, value) => expect(parseDingTalkReadRequest(value)).toBeNull())
})

describe('DingTalk package and loopback bridge', () => {
  beforeAll(initDingTalkBridge)
  beforeEach(() => {
    getSession.mockReset().mockReturnValue({})
    getSessionBridgeAccess.mockReset().mockReturnValue(access)
    read.mockReset().mockResolvedValue({ ok: true, data: { messages: [{ text: '合成的钉钉消息' }], hasMore: true } })
  })
  afterEach(() => {
    revokeDingTalkBridgeTokens(session)
    vi.unstubAllEnvs()
  })

  it('registers three read-only tools and reads through the Desktop session capability', async () => {
    vi.stubEnv(DINGTALK_TOOLS_ENV_KEY, dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY])
    const tools: Parameters<Parameters<typeof registerDingTalkTools>[0]['registerTool']>[0][] = []
    registerDingTalkTools({ registerTool: tool => tools.push(tool) })
    expect(tools.map(tool => [tool.name, tool.approval])).toEqual([
      ['toushou_dingtalk_search_messages', 'read'], ['toushou_dingtalk_search_documents', 'read'], ['toushou_dingtalk_read_document', 'read']
    ])
    const result = await tools[0].execute('synthetic-tool', { query: query.query })
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, source: 'DingTalk', data: { messages: [{ text: '合成的钉钉消息' }], hasMore: true } })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(query, expect.any(AbortSignal))
  })

  it('blocks forged capabilities, browser origins, and legacy remote and scheduled sessions', async () => {
    const url = dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY]
    expect((await post(url.replace(/[^/]+$/, 'forged'), query)).status).toBe(403)
    expect((await post(url, query, 'https://example.invalid')).status).toBe(403)
    getSession.mockReturnValue({ origin: 'task' })
    expect((await post(url, query)).status).toBe(403)
    getSession.mockReturnValue({ origin: 'feishu' })
    expect((await post(url, query)).status).toBe(403)
    getSession.mockReturnValue({})
    getSessionBridgeAccess.mockReturnValue({ ...access, remoteReadonly: true })
    expect((await post(url, query)).status).toBe(403)
    getSession.mockReturnValue(undefined)
    getSessionBridgeAccess.mockReturnValue(null)
    expect((await post(url, query)).status).toBe(403)
    expect(read).not.toHaveBeenCalled()
  })

  it('revokes in-flight and future calls when their originating session closes', async () => {
    const url = dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY]
    let requestSignal: AbortSignal | undefined
    const started = new Promise<void>(resolve => {
      read.mockImplementation((_tool, signal) => new Promise(done => {
        requestSignal = signal
        signal?.addEventListener('abort', () => done({ ok: false, error: 'read-failed' }), { once: true })
        resolve()
      }))
    })
    const request = post(url, query)
    await started
    revokeDingTalkBridgeTokens(session)
    expect(requestSignal?.aborted).toBe(true)
    expect((await request).status).toBe(403)
    expect((await post(url, query)).status).toBe(403)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not return fetched results after the originating workspace changes', async () => {
    const url = dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY]
    read.mockImplementation(async () => {
      getSessionBridgeAccess.mockReturnValue({ ...access, cwd: '/synthetic/other-project' })
      return { ok: true, data: { content: 'private workspace text' } }
    })
    const response = await post(url, query)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ ok: false, error: 'forbidden' })
  })

  it('keeps content access denial separate from authorization expiry', async () => {
    vi.stubEnv(DINGTALK_TOOLS_ENV_KEY, dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY])
    const tools: Parameters<Parameters<typeof registerDingTalkTools>[0]['registerTool']>[0][] = []
    registerDingTalkTools({ registerTool: tool => tools.push(tool) })
    read.mockResolvedValue({ ok: false, error: 'permission-denied' })
    const result = await tools[2].execute('synthetic-tool', { documentId: 'SyntheticId' })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: 'permission-denied', hint: expect.stringContaining('内容所有者') })
  })

  it('preserves an explicit truncation marker for oversized reads', async () => {
    const url = dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY]
    read.mockResolvedValue({ ok: true, data: { markdown: '素材数据'.repeat(20_000) } })
    const response = await post(url, { action: 'read_document', documentId: 'SyntheticId' })
    const body = await response.text()
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(48_000)
    expect(JSON.parse(body)).toMatchObject({ ok: true, truncated: true, truncation: { reason: 'transport-byte-limit' } })
  })
})
