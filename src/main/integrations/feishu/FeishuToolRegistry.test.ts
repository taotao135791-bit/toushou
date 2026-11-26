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
    expect(capabilityFor('doc_blocks')).toBe('docs.read')
    expect(capabilityFor('doc_insert_blocks')).toBe('docs.write')
    expect(capabilityFor('doc_table_fill')).toBe('docs.write')
    expect(capabilityFor('doc_delete_block')).toBe('docs.write')
    expect(capabilityFor('doc_file_attach')).toBe('docs.write')
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

  it('doc_insert_blocks sends children with index and reports the created block', async () => {
    const request = vi.fn(async (config: { url?: string; data?: { index?: number; children?: Array<{ block_type?: number }> } }) => {
      void config
      return { code: 0, data: { children: [{ block_id: 'new-1' }] } }
    })
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'token'
    )
    const result = await registry.execute({ action: 'doc_insert_blocks', documentId: 'doc1', index: 2, blocks: [{ type: 'heading', level: 1, text: '新批次' }, { type: 'text', text: '说明' }] })
    expect(result.ok).toBe(true)
    const config = (request.mock.calls[0]?.[0] ?? {}) as { url?: string; data?: { index?: number; children?: Array<{ block_type?: number }> } }
    expect(config.url).toContain('/blocks/doc1/children')
    expect(config.data?.index).toBe(2)
    expect(config.data?.children?.[0]?.block_type).toBe(3)
    expect(config.data?.children?.[1]?.block_type).toBe(2)
  })

  it('doc_table_fill creates the table then fills every cell in order', async () => {
    const calls: Array<Record<string, unknown>> = []
    const request = vi.fn(async (config: Record<string, unknown>) => {
      calls.push(config)
      const url = String(config.url)
      if (url.includes('/blocks/doc1/children') && (config.data as { children?: Array<{ block_type?: number }> } | undefined)?.children?.[0]?.block_type === 31) {
        return { code: 0, data: { children: [{ block_id: 'table-1' }] } }
      }
      if (url.includes('/blocks/table-1/children')) {
        return { code: 0, data: { items: [{ block_id: 'cell-1' }, { block_id: 'cell-2' }, { block_id: 'cell-3' }, { block_id: 'cell-4' }] } }
      }
      return { code: 0, data: {} }
    })
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'token'
    )
    const result = await registry.execute({ action: 'doc_table_fill', documentId: 'doc1', cells: [['指标', '数值'], ['安装', '1200']] })
    expect(result.ok).toBe(true)
    // 建表 → 查格子 → 4 次填充
    expect(request).toHaveBeenCalledTimes(2 + 4)
    const fillCalls = calls.filter(config => String(config.url).includes('/blocks/cell-'))
    expect(fillCalls).toHaveLength(4)
    const contentOf = (config: Record<string, unknown> | undefined): string => {
      const data = (config as { data?: { children?: Array<{ text?: { elements?: Array<{ text_run?: { content?: string } }> } }> } } | undefined)?.data
      return data?.children?.[0]?.text?.elements?.[0]?.text_run?.content ?? ''
    }
    expect(contentOf(fillCalls[0])).toBe('指标')
    expect(contentOf(fillCalls[3])).toBe('1200')
  })

  it('doc_table_fill reports a partial fill failure with the failing cell position', async () => {
    let fillCalls = 0
    const request = vi.fn(async (config: Record<string, unknown>) => {
      const url = String(config.url)
      if (url.includes('/blocks/doc1/children') && (config.data as { children?: Array<{ block_type?: number }> } | undefined)?.children?.[0]?.block_type === 31) {
        return { code: 0, data: { children: [{ block_id: 'table-1' }] } }
      }
      if (url.includes('/blocks/table-1/children')) {
        return { code: 0, data: { items: [{ block_id: 'c1' }, { block_id: 'c2' }] } }
      }
      fillCalls += 1
      if (fillCalls === 2) return { code: 99991661, msg: 'forbidden' }
      return { code: 0, data: {} }
    })
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'token'
    )
    const result = await registry.execute({ action: 'doc_table_fill', documentId: 'doc1', cells: [['a', 'b']] })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('第 1 行第 2 列')
  })

  it('doc_blocks reads the child block list with pagination', async () => {
    const request = vi.fn(async () => ({ code: 0, data: { items: [{ block_id: 'b1', block_type: 2, text: { elements: [{ text_run: { content: '段落' } }] } }, { block_id: 'b2', block_type: 3, heading1: { elements: [{ text_run: { content: '标题' } }] } }], has_more: false } }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'token'
    )
    const result = await registry.execute({ action: 'doc_blocks', documentId: 'doc1' })
    expect(result.ok).toBe(true)
    expect((result.data as { blocks: Array<{ text: string }> }).blocks.map(b => b.text)).toEqual(['段落', '标题'])
  })

  it('doc_file_attach uploads the local file and writes the token back', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const dir = mkdtempSync(path.join(tmpdir(), 'attach-'))
    const localPath = path.join(dir, 'report.pdf')
    writeFileSync(localPath, Buffer.alloc(2048, 7))
    const seen: Array<Record<string, unknown>> = []
    const uploadAll = vi.fn(async (params: Record<string, unknown>) => {
      seen.push({ url: '/medias/upload_all', ...params })
      return { code: 0, data: { token: 'file-token-1' } }
    })
    const request = vi.fn(async (config: Record<string, unknown>) => {
      seen.push(config)
      const url = String(config.url)
      if (url.includes('/blocks/') && url.endsWith('/children') && (config.data as { children?: Array<{ block_type?: number }> })?.children?.[0]?.block_type === 27) {
        return { code: 0, data: { children: [{ block_id: 'file-block-1' }] } }
      }
      if (config.method === 'PATCH') return { code: 0, data: {} }
      return { code: 0, data: {} }
    })
    const channel = { rawClient: { request, drive: { v1: { media: { uploadAll } } } } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'token'
    )
    const result = await registry.execute({ action: 'doc_file_attach', documentId: 'doc1', localPath })
    expect(result.ok).toBe(true)
    // 上传走 SDK 的 uploadAll：参数含正确 parent_type/parent_node（教程 6.1 流程）
    const uploadCall = uploadAll.mock.calls[0]?.[0] as { parent_type?: string; parent_node?: string; file_name?: string; size?: number } | undefined
    expect(uploadCall?.parent_type).toBe('docx_file')
    expect(uploadCall?.parent_node).toBe('file-block-1')
    expect(uploadCall?.size).toBe(2048)
    const patch = seen.find(config => String(config.method) === 'PATCH')
    const patchData = patch?.data as { file?: { token?: string } } | undefined
    expect(patchData?.file?.token).toBe('file-token-1')
  })

  it('doc_file_attach refuses missing local files without any network call', async () => {
    const request = vi.fn()
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'token'
    )
    const result = await registry.execute({ action: 'doc_file_attach', documentId: 'doc1', localPath: 'D:/definitely/missing/file.pdf' })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('本地文件不存在')
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
