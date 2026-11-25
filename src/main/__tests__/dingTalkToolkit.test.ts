import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import register from '../../../resources/dingtalk-toolkit/extensions/index'
import directory from '../../../resources/dingtalk-toolkit/catalog/operations.json'

type Tool = Parameters<Parameters<typeof register>[0]['registerTool']>[0]
const tools = new Map<string, Tool>()
register({ registerTool: tool => tools.set(tool.name, tool) })
const create = tools.get('toushou_dingtalk_create_document')!
const append = tools.get('toushou_dingtalk_append_document')!
const fetchMock = vi.fn<typeof fetch>()
const bridge = 'http://127.0.0.1:9999/' + 'a'.repeat(48)
const exampleId = 'ExampleDoc'

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubEnv('TOUSHOU_DINGTALK', bridge)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('DingTalk document tools', () => {
  it('publishes distinct write tools with explicit required fields and limits', () => {
    expect(create.approval).toBe('write')
    expect(append.approval).toBe('write')
    expect(create.parameters).toMatchObject({
      required: ['title'], additionalProperties: false, properties: {
        title: { maxLength: 200 }, content: { maxLength: 64_000 }, folderId: { maxLength: 2048 }
      }
    })
    expect(append.parameters).toMatchObject({
      required: ['documentId', 'content'], additionalProperties: false, properties: {
        documentId: { maxLength: 2048 }, content: { maxLength: 64_000 }
      }
    })
  })

  it.each([
    [create, 'create_document', { title: '示例文档' }],
    [create, 'create_document', { title: '示例文档', content: '# 示例正文\n', folderId: 'ExampleFolder' }],
    [append, 'append_document', { documentId: exampleId, content: '\n## 示例\n\n  - 追加正文\n' }]
  ] as const)('sends a single request with the specified fields and preserves Markdown whitespace', async (tool, action, arguments_) => {
    const reply = { ok: true, source: 'DingTalk', data: { documentId: exampleId } }
    fetchMock.mockResolvedValue(Response.json(reply))
    const result = await tool.execute('call', arguments_)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(bridge)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) })
    expect(JSON.parse(init?.body as string)).toEqual({ action, ...arguments_ })
    expect(JSON.parse(result.content[0].text)).toEqual(reply)
  })

  it.each([
    [create, { content: 'missing-title' }],
    [create, { title: ' ', folderId: 'ExampleFolder' }],
    [create, { title: '示例文档', action: 'other_action' }],
    [create, { title: '示例文档', folderId: 1 }],
    [append, { documentId: exampleId, content: 'x'.repeat(64_001) }],
    [append, { documentId: exampleId, content: '示例', extra: true }]
  ] as const)('rejects undeclared, missing or invalid input before contacting the bridge', async (tool, params) => {
    const result = await tool.execute('call', params)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: 'invalid-input' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps remote denial, desktop permission denial and uncertain completion distinct', async () => {
    for (const error of ['permission-denied', 'write-forbidden', 'write-failed', 'write-outcome-unknown']) {
      fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error }))
      const result = await create.execute('call', { title: '示例文档' })
      expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error, hint: expect.any(String) })
    }
    fetchMock.mockRejectedValueOnce(new Error('synthetic disconnect'))
    const result = await append.execute('call', { documentId: exampleId, content: '示例' })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: 'write-outcome-unknown', hint: expect.stringContaining('核对正文') })
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('provides an official verification link only for a valid node reported on an uncertain write', async () => {
    const error = 'write-outcome-unknown'
    const misleadingUrl = 'https://example.invalid/not-the-document'
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error, nodeId: exampleId, url: misleadingUrl }))
    const verified = JSON.parse((await create.execute('call', { title: '示例文档' })).content[0].text)
    expect(verified).toMatchObject({ ok: false, error, nodeId: exampleId, url: `https://alidocs.dingtalk.com/i/nodes/${exampleId}` })
    for (const invalid of ['../other', misleadingUrl, 'x'.repeat(201)]) {
      fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error, nodeId: invalid, url: misleadingUrl }))
      const result = JSON.parse((await create.execute('call', { title: '示例文档' })).content[0].text)
      expect(result.nodeId).toBeUndefined()
      expect(result.url).toBeUndefined()
    }
    for (const otherError of ['write-forbidden', 'unexpected-error']) {
      fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: otherError, nodeId: exampleId }))
      expect(JSON.parse((await create.execute('call', { title: '示例文档' })).content[0].text).url).toBeUndefined()
    }
  })

  it('declines nonlocal bridge configuration without sending document contents', async () => {
    vi.stubEnv('TOUSHOU_DINGTALK', 'https://example.invalid/' + 'a'.repeat(48))
    expect(JSON.parse((await create.execute('call', { title: '示例文档' })).content[0].text)).toMatchObject({ ok: false, error: 'forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('DingTalk workspace tools', () => {
  const catalog = tools.get('toushou_dingtalk_workspace_catalog')!
  const read = tools.get('toushou_dingtalk_workspace_read')!
  const write = tools.get('toushou_dingtalk_workspace_write')!

  it('registers three compact workspace entry points alongside the five existing tools', () => {
    expect(tools.size).toBe(8)
    expect([catalog.approval, read.approval, write.approval]).toEqual(['read', 'read', 'write'])
    expect(catalog.parameters).toMatchObject({
      properties: { cursor: { type: 'integer', minimum: 0 } }, required: [], additionalProperties: false
    })
    expect(write.parameters).toMatchObject({
      properties: { args: { type: 'object', additionalProperties: true } }, required: ['operation', 'args'],
      additionalProperties: false
    })
  })

  it('accepts the identifiers returned by the bundled directory', () => {
    const { properties } = catalog.parameters as { properties: Record<string, { pattern: string; maxLength: number }> }
    for (const [name, values] of [
      ['operation', directory.operations.map(item => item.id)],
      ['service', Array.from(new Set(directory.operations.map(item => item.path[0])))]
    ] as const) {
      const field = properties[name]
      const pattern = new RegExp(field.pattern)
      expect(values.filter(value => value.length > field.maxLength || !pattern.test(value))).toEqual([])
    }
  })

  it.each([{}, { service: 'sheet', cursor: 12 }, { operation: 'sheet.range.read' }])('discovers services, a page of actions or one parameter schema on demand', async params => {
    const reply = { ok: true, data: { service: 'sheet' } }
    fetchMock.mockResolvedValue(Response.json(reply))
    const result = await catalog.execute('catalog', params)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ action: 'workspace_catalog', ...params })
    expect(JSON.parse(result.content[0].text)).toEqual(reply)
  })

  it('preserves nested business arguments and the read/write distinction without rewriting the values', async () => {
    const readArgs = { node: 'ExampleDoc', 'sheet-id': 'ExampleTab', range: 'A1:B2' }
    const writeArgs = { ...readArgs, values: [['示例', 8], ['', false]] }
    for (const [tool, action, operation, args] of [
      [read, 'workspace_read', 'sheet.range.read', readArgs],
      [write, 'workspace_write', 'sheet.range.update', writeArgs]
    ] as const) {
      fetchMock.mockResolvedValueOnce(Response.json({ ok: true, data: { range: args.range } }))
      const result = await tool.execute('operation', { operation, args })
      expect(JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)).toEqual({ action, operation, args })
      expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true })
    }
  })

  it.each([
    [catalog, { cursor: -1 }], [catalog, { cursor: 1.5 }], [catalog, { cursor: '1' }], [catalog, { cursor: 100_001 }],
    [read, { operation: 'sheet range read --profile other', args: {} }],
    [read, { operation: 'sheet.range.read', args: [] }],
    [read, { operation: 'sheet.range.read', args: '--command' }],
    [write, { args: {} }], [write, { operation: 'sheet.range.update' }],
    [write, { operation: 'sheet.range.update', args: {}, action: 'workspace_read' }]
  ] as const)('rejects malformed envelopes locally', async (tool, params) => {
    const result = await tool.execute('invalid', params)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: 'invalid-input' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a cancelled file selection without suggesting another attempt or exposing a local path', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: 'cancelled', path: 'example.csv' }))
    const result = await write.execute('cancel', { operation: 'drive.upload', args: {} })
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: false, error: 'cancelled', hint: '已取消本次文件操作。' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks to verify the business resource after an uncertain write and never repeats it', async () => {
    const params = { operation: 'sheet.range.update', args: {} }
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: 'write-outcome-unknown', nodeId: exampleId }))
    const uncertain = JSON.parse((await write.execute('write', params)).content[0].text)
    expect(uncertain).toMatchObject({ ok: false, error: 'write-outcome-unknown', hint: expect.stringContaining('先读取目标') })
    expect(uncertain).not.toHaveProperty('url')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    const interrupted = JSON.parse((await write.execute('write', params)).content[0].text)
    expect(interrupted).toEqual(uncertain)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
