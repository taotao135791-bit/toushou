import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DingTalkToolRequest, DingTalkToolResult } from '../shared/connections'
import registerDingTalkTools from '../../resources/dingtalk-toolkit/extensions/index'

type SessionAccess = { cwd: string; remoteReadonly: boolean; mode: 'full' | 'no-bash' | 'ask' | 'readonly' }

const { execute, initialize, connectedLifetime, getSession, getSessionBridgeAccess, showMessageBox, getFocusedWindow } = vi.hoisted(() => ({
  execute: vi.fn<(tool: DingTalkToolRequest, signal: AbortSignal, canWrite?: () => boolean) => Promise<DingTalkToolResult>>(),
  initialize: vi.fn<() => Promise<void>>(),
  connectedLifetime: vi.fn<() => AbortSignal | null>(),
  getSession: vi.fn<() => { origin?: 'feishu' | 'task' } | undefined>(),
  getSessionBridgeAccess: vi.fn<() => SessionAccess | null>(),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(),
  getFocusedWindow: vi.fn<() => { isDestroyed(): boolean } | null>()
}))

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow, getAllWindows: () => [] }, dialog: { showMessageBox } }))
vi.mock('./omp', () => ({ getSession, getSessionBridgeAccess }))
vi.mock('./integrations/dingtalk/DingTalkConnectionManager', () => ({
  dingTalkConnectionManager: { execute, initialize, connectedLifetime }
}))

import { DINGTALK_TOOLS_ENV_KEY, dingTalkBridgeEnv, initDingTalkBridge, parseDingTalkRequest, revokeDingTalkBridgeTokens } from './dingTalkBridge'

const session = 'synthetic-dingtalk-session'
const access: SessionAccess = { cwd: '/synthetic/project', remoteReadonly: false, mode: 'full' }
const query: DingTalkToolRequest = { action: 'search_messages', query: '投放复盘' }

async function post(url: string, body: unknown, origin?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body)
  })
}

describe('DingTalk request validation', () => {
  it('accepts an explicit keyword or an ID and discards query parameters from an official document link', () => {
    expect(parseDingTalkRequest({ action: 'search_documents', query: '  滚动预算  ' })).toEqual({ action: 'search_documents', query: '滚动预算' })
    expect(parseDingTalkRequest({ action: 'read_document', documentId: 'ABC_123-ab' })).toEqual({ action: 'read_document', documentId: 'ABC_123-ab' })
    expect(parseDingTalkRequest({ action: 'read_document', documentId: 'https://alidocs.dingtalk.com/i/nodes/ABC_123-ab?shareId=example' })).toEqual({ action: 'read_document', documentId: 'ABC_123-ab' })
  })

  it('accepts optional initial Markdown and a folder link for creation, preserving whitespace', () => {
    const title = '示例文档'
    const content = '#  第一节\r\n\r\n    示例代码\n'
    const nodeUrl = 'https://alidocs.dingtalk.com/i/nodes/Example123?shareId=sample'
    expect(parseDingTalkRequest({ action: 'create_document', title })).toEqual({ action: 'create_document', title })
    expect(parseDingTalkRequest({ action: 'create_document', title, content, folderId: nodeUrl })).toEqual({
      action: 'create_document', title, content, folderId: 'Example123'
    })
    expect(parseDingTalkRequest({ action: 'append_document', content, documentId: nodeUrl })).toEqual({
      action: 'append_document', content, documentId: 'Example123'
    })
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
    ['alternate creation targets', { action: 'create_document', title: '示例', workspaceId: 'ExampleSpace' }],
    ['invalid folder links', { action: 'create_document', title: '示例', folderId: 'https://example.invalid/i/nodes/ABC' }],
    ['oversized titles', { action: 'create_document', title: 'a'.repeat(201) }],
    ['missing append body', { action: 'append_document', documentId: 'ABC' }],
    ['empty append body', { action: 'append_document', documentId: 'ABC', content: '  ' }],
    ['oversized writes', { action: 'append_document', documentId: 'ABC', content: '示'.repeat(64_001) }],
    ['extra append arguments', { action: 'append_document', documentId: 'ABC', content: '示例', overwrite: true }],
    ['untrusted paths', { action: 'read_document', documentId: '../other-tenant' }]
  ])('rejects %s', (_label, value) => expect(parseDingTalkRequest(value)).toBeNull())
})

describe('DingTalk package and loopback bridge', () => {
  const append: DingTalkToolRequest = { action: 'append_document', documentId: 'ExampleNode', content: '## 示例\n\n正文\n' }
  const receipt = { nodeId: 'ExampleNode', url: 'https://alidocs.dingtalk.com/i/nodes/ExampleNode' }
  let binding: AbortController
  const endpoint = () => dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY]

  beforeAll(initDingTalkBridge)
  beforeEach(() => {
    binding = new AbortController()
    initialize.mockReset().mockResolvedValue(undefined)
    connectedLifetime.mockReset().mockReturnValue(binding.signal)
    showMessageBox.mockReset().mockResolvedValue({ response: 1 })
    getFocusedWindow.mockReset().mockReturnValue({ isDestroyed: () => false })
    getSession.mockReset().mockReturnValue({})
    getSessionBridgeAccess.mockReset().mockReturnValue(access)
    execute.mockReset().mockResolvedValue({ ok: true, data: { messages: [{ text: '合成的钉钉消息' }], hasMore: true } })
  })
  afterEach(() => {
    revokeDingTalkBridgeTokens(session)
    vi.unstubAllEnvs()
  })

  it('registers three reads and two writes and reads through the desktop session capability', async () => {
    vi.stubEnv(DINGTALK_TOOLS_ENV_KEY, dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY])
    const tools: Parameters<Parameters<typeof registerDingTalkTools>[0]['registerTool']>[0][] = []
    registerDingTalkTools({ registerTool: tool => tools.push(tool) })
    expect(tools.map(tool => [tool.name, tool.approval])).toEqual([
      ['toushou_dingtalk_search_messages', 'read'], ['toushou_dingtalk_search_documents', 'read'],
      ['toushou_dingtalk_read_document', 'read'],
      ['toushou_dingtalk_create_document', 'write'], ['toushou_dingtalk_append_document', 'write']
    ])
    const result = await tools[0].execute('synthetic-tool', { query: query.query })
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, source: 'DingTalk', data: { messages: [{ text: '合成的钉钉消息' }], hasMore: true } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0].slice(0, 2)).toEqual([query, expect.any(AbortSignal)])
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
    expect(execute).not.toHaveBeenCalled()
  })

  it('revokes in-flight and future calls when their originating session closes', async () => {
    const url = dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY]
    let requestSignal: AbortSignal | undefined
    const started = new Promise<void>(resolve => {
      execute.mockImplementation((_tool, signal) => new Promise(done => {
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
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not return fetched results after the originating workspace changes', async () => {
    const url = dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY]
    execute.mockImplementation(async () => {
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
    execute.mockResolvedValue({ ok: false, error: 'permission-denied' })
    const result = await tools[2].execute('synthetic-tool', { documentId: 'SyntheticId' })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: 'permission-denied', hint: expect.stringContaining('内容所有者') })
  })

  it.each(['full', 'no-bash'] as const)('allows document writes with %s access and accepts long multiline Markdown', async mode => {
    getSessionBridgeAccess.mockReturnValue({ ...access, mode })
    execute.mockResolvedValue({ ok: true, data: receipt })
    const content = '# 示例报告\n\n' + '  多行正文\n'.repeat(2_000)
    const request = { action: 'create_document', title: '示例报告', content }
    const result = await post(endpoint(), request)
    expect(await result.json()).toMatchObject({ ok: true, data: receipt })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toEqual(request)
  })

  it('allows read-only sessions to query but refuses their document writes', async () => {
    getSessionBridgeAccess.mockReturnValue({ ...access, mode: 'readonly' })
    expect(await (await post(endpoint(), query)).json()).toMatchObject({ ok: true })
    expect(await (await post(endpoint(), append)).json()).toMatchObject({ ok: false, error: 'write-forbidden' })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('refuses writes from remote and scheduled sessions before dispatch', async () => {
    const url = endpoint()
    getSessionBridgeAccess.mockReturnValue({ ...access, remoteReadonly: true })
    expect(await (await post(url, append)).json()).toMatchObject({ ok: false })
    getSessionBridgeAccess.mockReturnValue(access)
    getSession.mockReturnValue({ origin: 'task' })
    expect(await (await post(url, append)).json()).toMatchObject({ ok: false })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('writes only after approval in ask mode, and declines when confirmation is unavailable', async () => {
    const url = endpoint()
    getSessionBridgeAccess.mockReturnValue({ ...access, mode: 'ask' })
    execute.mockResolvedValue({ ok: true, data: receipt })
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await (await post(url, append)).json()).toMatchObject({ ok: false, error: 'write-forbidden' })
    getFocusedWindow.mockReturnValueOnce(null)
    expect(await (await post(url, append)).json()).toMatchObject({ ok: false, error: 'write-forbidden' })
    expect(execute).not.toHaveBeenCalled()
    expect(await (await post(url, append)).json()).toMatchObject({ ok: true, data: receipt })
    expect(showMessageBox).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toEqual(append)
  })

  it.each(['permission', 'workspace', 'session', 'binding'] as const)('refuses a write when %s changes while the native confirmation is open', async change => {
    const url = endpoint()
    getSessionBridgeAccess.mockReturnValue({ ...access, mode: 'ask' })
    showMessageBox.mockImplementationOnce(async () => {
      if (change === 'permission') getSessionBridgeAccess.mockReturnValue({ ...access, mode: 'readonly' })
      if (change === 'workspace') getSessionBridgeAccess.mockReturnValue({ ...access, mode: 'ask', cwd: '/synthetic/other' })
      if (change === 'session') revokeDingTalkBridgeTokens(session)
      if (change === 'binding') {
        binding.abort()
        connectedLifetime.mockReturnValue(new AbortController().signal)
      }
      return { response: 1 }
    })
    expect(await (await post(url, append)).json()).toMatchObject({ ok: false })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not dispatch a direct write if the session becomes read-only during connection setup', async () => {
    initialize.mockImplementationOnce(async () => {
      getSessionBridgeAccess.mockReturnValue({ ...access, mode: 'readonly' })
    })
    expect(await (await post(endpoint(), append)).json()).toMatchObject({ ok: false })
    expect(execute).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('gives the manager a live permission check for dispatch after async preparation', async () => {
    let allowedBefore: boolean | undefined
    let allowedAfter: boolean | undefined
    execute.mockImplementationOnce(async (_request, _signal, canWrite) => {
      allowedBefore = canWrite?.()
      getSessionBridgeAccess.mockReturnValue({ ...access, mode: 'readonly' })
      allowedAfter = canWrite?.()
      return { ok: false, error: 'write-forbidden' }
    })
    expect(await (await post(endpoint(), append)).json()).toMatchObject({ ok: false })
    expect(allowedBefore).toBe(true)
    expect(allowedAfter).toBe(false)
  })

  it.each(['workspace', 'session'] as const)('returns an uncertain outcome without the receipt if the %s changes after write dispatch', async change => {
    const url = endpoint()
    execute.mockImplementationOnce(async () => {
      if (change === 'workspace') getSessionBridgeAccess.mockReturnValue({ ...access, cwd: '/synthetic/other' })
      else revokeDingTalkBridgeTokens(session)
      return { ok: true, data: receipt }
    })
    const result = await post(url, append)
    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({ ok: false, error: 'write-outcome-unknown' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('keeps uncertain remote completion explicit without retrying the write', async () => {
    execute.mockResolvedValue({ ok: false, error: 'write-outcome-unknown', nodeId: 'ExampleNode' })
    const result = await post(endpoint(), append)
    expect(await result.json()).toMatchObject({ ok: false, error: 'write-outcome-unknown', nodeId: 'ExampleNode' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('preserves an explicit truncation marker for oversized reads', async () => {
    const url = dingTalkBridgeEnv(session)[DINGTALK_TOOLS_ENV_KEY]
    execute.mockResolvedValue({ ok: true, data: { markdown: '素材数据'.repeat(20_000) } })
    const response = await post(url, { action: 'read_document', documentId: 'SyntheticId' })
    const body = await response.text()
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(48_000)
    expect(JSON.parse(body)).toMatchObject({ ok: true, truncated: true, truncation: { reason: 'transport-byte-limit' } })
  })
})
