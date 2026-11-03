import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sessionTopic from '../../resources/session-topic/index'

let original: string | undefined
beforeEach(() => { original = process.env.TOUSHOU_SESSION_TOPIC; process.env.TOUSHOU_SESSION_TOPIC = 'http://127.0.0.1:12345/synthetic-token' })
afterEach(() => {
  if (original === undefined) delete process.env.TOUSHOU_SESSION_TOPIC
  else process.env.TOUSHOU_SESSION_TOPIC = original
  vi.unstubAllGlobals()
})
function fixture() {
  const api = { on: vi.fn(), registerTool: vi.fn() }
  sessionTopic(api)
  return {
    api,
    beforeStart: api.on.mock.calls[0][1] as Parameters<Parameters<typeof sessionTopic>[0]['on']>[1],
    tool: api.registerTool.mock.calls[0][0] as Parameters<Parameters<typeof sessionTopic>[0]['registerTool']>[0]
  }
}

describe('same-conversation topic extension', () => {
  it('is inert outside a GUI-bound process', () => {
    delete process.env.TOUSHOU_SESSION_TOPIC
    const api = { on: vi.fn(), registerTool: vi.fn() }
    sessionTopic(api)
    expect(api.on).not.toHaveBeenCalled()
    expect(api.registerTool).not.toHaveBeenCalled()
  })

  it('registers exactly one approval-free metadata tool with no arbitrary session or path selector', () => {
    const { api, tool } = fixture()
    expect(api.registerTool).toHaveBeenCalledOnce()
    expect(tool.name).toBe('toushou_session_topic')
    expect(tool.approval).toBe('read')
    expect(tool.loadMode).toBe('essential')
    expect(tool.parameters).toMatchObject({ required: ['title', 'revision'], additionalProperties: false })
    expect(JSON.stringify(tool.parameters)).not.toMatch(/sessionId|filePath|provider|apiKey/)
  })

  it.each(['legacy', 'current'])('injects a bounded revision into the %s prompt without an extra model task', async (runtime) => {
    const fetcher = vi.fn(async (_url: unknown, _options: RequestInit) => ({ ok: true, json: async () => ({ ok: true, revision: 7, manual: false }) }))
    vi.stubGlobal('fetch', fetcher)
    const { beforeStart } = fixture()
    const result = await beforeStart({ systemPrompt: runtime === 'legacy' ? 'existing persona' : ['existing persona'] })
    expect(result?.systemPrompt[0]).toBe(runtime === 'legacy' ? 'e' : 'existing persona')
    expect(JSON.stringify(result)).toContain('revision=7')
    expect(JSON.stringify(result)).toContain('Do not call another model')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ action: 'context' })
  })

  it('omits instructions when the title is manual or the host is unavailable', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, revision: 3, manual: true }) }).mockRejectedValueOnce(new Error('synthetic provider failure sk-private123'))
    vi.stubGlobal('fetch', fetcher)
    const { beforeStart } = fixture()
    await expect(beforeStart({ systemPrompt: ['persona'] })).resolves.toBeUndefined()
    await expect(beforeStart({ systemPrompt: ['persona'] })).resolves.toBeUndefined()
  })

  it('forwards the captured expected revision and cannot select another session', async () => {
    const fetcher = vi.fn(async (_url: unknown, _options: RequestInit) => ({ ok: true, json: async () => ({ ok: false, error: 'stale-topic' }) }))
    vi.stubGlobal('fetch', fetcher)
    const { tool } = fixture()
    const result = await tool.execute('synthetic-call', { title: '成本诊断', revision: 2, sessionId: 'other', filePath: '/synthetic/other' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ action: 'topic', title: '成本诊断', revision: 2 })
    expect(result.content[0].text).toBe('{"ok":false,"error":"stale-topic"}')
  })

  it('returns only a safe fixed code when transport fails without affecting the main answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sk-syntheticSensitiveFailure')))
    const { tool } = fixture()
    expect(await tool.execute('call', { title: '主题', revision: 1 })).toEqual({ content: [{ type: 'text', text: '{"ok":false,"error":"topic-unavailable"}' }] })
  })
})
