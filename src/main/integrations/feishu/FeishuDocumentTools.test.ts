import { Client, type HttpInstance } from '@larksuiteoapi/node-sdk'
import { ReadStream } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { FeishuDocumentTools, type FeishuAttachmentPicker } from './FeishuDocumentTools'
import { capabilityFor, FeishuToolRegistry } from './FeishuToolRegistry'

interface SdkRequest {
  method: string
  url: string
  headers: Record<string, string>
  params?: Record<string, unknown>
  data?: Record<string, unknown>
}

type Step = unknown | ((request: SdkRequest) => unknown)

const ok = (data: unknown) => ({ code: 0, data })
const revision = (value: number) => ok({ document: { revision_id: value } })
const inserted = (block: object, value = 8) => ok({ children: [block], document_revision_id: value })
const document = 'document123'
const token = 'fixture-user-token'
const upload = ok({ file_token: 'fixture-file-token' })

function fixture(...steps: Step[]) {
  const logger = {
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn()
  }
  const request = vi.fn(async (config: SdkRequest) => {
    if (steps.length === 0) throw new Error('unexpected SDK request')
    const next = steps.shift()
    return typeof next === 'function' ? next(config) : next
  })
  const client = new Client({
    appId: 'synthetic-app', appSecret: 'synthetic-secret', logger,
    httpInstance: { request } as unknown as HttpInstance
  })
  return { client, request }
}

function expectUserIdentity(request: ReturnType<typeof fixture>['request']) {
  for (const [call] of request.mock.calls) expect(call.headers.Authorization).toBe(`Bearer ${token}`)
}

describe('Feishu document tools with the real SDK and a stub transport', () => {
  it('returns opaque continuation and keeps the same document revision for the next page', async () => {
    const firstPage = ok({ items: [{ block_id: 'first', block_type: 13, ordered: { elements: [{ text_run: { content: '有序列表' } }] } }], has_more: true, page_token: 'next-page' })
    const { client, request } = fixture(revision(7), firstPage, ok({ items: [{ block_id: 'second', block_type: 31, children: ['cell'] }] }))
    const tools = new FeishuDocumentTools(client, token)
    expect(await tools.execute({ action: 'doc_blocks', documentId: document })).toMatchObject({
      ok: true, data: { documentRevision: 7, hasMore: true, nextPageToken: 'next-page', blocks: [{ block_id: 'first', text: '有序列表' }] }
    })
    expect(await tools.execute({ action: 'doc_blocks', documentId: document, documentRevision: 7, pageToken: 'next-page' })).toMatchObject({
      ok: true, data: { documentRevision: 7, hasMore: false, blocks: [{ block_id: 'second', childCount: 1 }] }
    })
    expect(request.mock.calls[2][0].params).toMatchObject({ document_revision_id: 7, page_token: 'next-page' })
    expectUserIdentity(request)
  })

  it('bounds preview text without dropping blocks or hiding pagination', async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      block_id: `block${index}`, block_type: 2,
      text: { elements: [{ text_run: { content: '示例文字'.repeat(500) } }] }
    }))
    const { client } = fixture(ok({ items, has_more: true, page_token: 'opaque' }))
    const result = await new FeishuDocumentTools(client, token).execute({
      action: 'doc_blocks', documentId: document, documentRevision: 7, pageSize: 50
    })
    expect(result).toMatchObject({ ok: true, data: { nextPageToken: 'opaque', blocks: expect.any(Array) } })
    const data = result.data as { blocks: Array<{ block_id: string; textTruncated?: boolean }> }
    expect(data.blocks.map(block => block.block_id)).toEqual(items.map(block => block.block_id))
    expect(data.blocks.every(block => block.textTruncated)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(24_000)
  })

  it('rejects malformed blocks, tables and unpinned positions before any SDK request', async () => {
    const { client, request } = fixture()
    const tools = new FeishuDocumentTools(client, token)
    const target = { documentId: document }
    for (const input of [
      { ...target, action: 'doc_insert_blocks', blocks: [{ type: 'heading', level: 10, text: 'x' }] },
      { ...target, action: 'doc_table_fill', cells: [['x'], ['y', 'z']] },
      { ...target, action: 'doc_table_fill', cells: [['x'], [null]] },
      { ...target, action: 'doc_insert_blocks', index: 2, blocks: [{ type: 'text', text: 'x' }] },
      { ...target, action: 'doc_blocks', pageToken: 'not-pinned' }
    ] as const) expect((await tools.execute(input)).ok).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('writes ordered lists with the typed SDK block shape and requested revision', async () => {
    const { client, request } = fixture(inserted({ block_id: 'created', block_type: 13 }))
    const result = await new FeishuDocumentTools(client, token).execute({
      action: 'doc_insert_blocks', documentId: document, parentBlockId: 'paragraph',
      documentRevision: 7, index: 2, blocks: [{ type: 'number', text: '序号' }]
    })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', url: expect.stringContaining('/blocks/paragraph/children'),
      params: { document_revision_id: 7, client_token: expect.any(String) },
      data: { index: 2, children: [{ block_type: 13, ordered: { elements: [{ text_run: { content: '序号' } }] } }] }
    }))
    expect(result).toMatchObject({ ok: true, data: { documentRevision: 8, blocks: [{ block_id: 'created' }] } })
    expectUserIdentity(request)
  })

  it('updates the existing block through update_text_elements', async () => {
    const { client, request } = fixture(
      revision(7), ok({ block: { block_id: 'title', block_type: 3 } }),
      ok({ block: { block_id: 'title', block_type: 3 }, document_revision_id: 8 })
    )
    const result = await new FeishuDocumentTools(client, token).execute({
      action: 'doc_update_block', documentId: document, blockId: 'title', text: '新版标题'
    })
    expect(request.mock.calls[2][0]).toMatchObject({
      method: 'PATCH', params: { document_revision_id: 7 },
      data: { update_text_elements: { elements: [{ text_run: { content: '新版标题' } }] } }
    })
    expect(result).toMatchObject({ ok: true, data: { block: { block_id: 'title', block_type: 3 } } })
  })

  it('locates a nested block across pages and deletes the exact range at the pinned revision', async () => {
    const { client, request } = fixture(
      revision(7), ok({ block: { block_id: 'target', parent_id: 'parent' } }),
      ok({ items: [{ block_id: 'first' }], has_more: true, page_token: 'p2' }),
      ok({ items: [{ block_id: 'previous' }, { block_id: 'target' }, { block_id: 'next' }] }),
      ok({ document_revision_id: 8 })
    )
    expect(await new FeishuDocumentTools(client, token).execute({ action: 'doc_delete_block', documentId: document, blockId: 'target' }))
      .toMatchObject({ ok: true, data: { parentBlockId: 'parent', blockId: 'target', deleted: true } })
    expect(request.mock.calls[3][0].params).toMatchObject({ document_revision_id: 7, page_token: 'p2' })
    expect(request.mock.calls[4][0]).toMatchObject({
      method: 'DELETE', url: expect.stringContaining('/blocks/parent/children/batch_delete'),
      params: { document_revision_id: 7 }, data: { start_index: 2, end_index: 3 }
    })
  })

  it('does not delete anything if the supplied parent is stale', async () => {
    const { client, request } = fixture(ok({ block: { block_id: 'target', parent_id: 'different' } }))
    const result = await new FeishuDocumentTools(client, token).execute({
      action: 'doc_delete_block', documentId: document, blockId: 'target', parentBlockId: 'stale', documentRevision: 7
    })
    expect(result.ok).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('creates populated cells under one table in a single mutation', async () => {
    const { client, request } = fixture(ok({
      block_id_relations: [{ temporary_block_id: 'table', block_id: 'new-table' }], document_revision_id: 8
    }))
    const result = await new FeishuDocumentTools(client, token).execute({
      action: 'doc_table_fill', documentId: document, documentRevision: 7, cells: [['方向', '数量'], ['示例', '']]
    })
    expect(result).toMatchObject({ ok: true, data: { tableBlockId: 'new-table', rows: 2, columns: 2, documentRevision: 8 } })
    expect(request).toHaveBeenCalledTimes(1)
    const call = request.mock.calls[0][0]
    expect(call).toMatchObject({
      method: 'POST', url: expect.stringContaining('/descendant'),
      data: { children_id: ['table'] }
    })
    expect(call.data?.descendants).toMatchObject([
      { block_type: 31, table: { property: { row_size: 2, column_size: 2, header_row: true } } },
      { block_id: 'cell_0', block_type: 32, children: ['text_0'] },
      { block_id: 'text_0', block_type: 2, text: { elements: [{ text_run: { content: '方向' } }] } },
      { block_type: 32 }, { block_type: 2 }, { block_type: 32 }, { block_type: 2 },
      { block_type: 32 }, { block_type: 2, text: { elements: [{ text_run: { content: '' } }] } }
    ])
  })

  it('returns an uncertain write receipt without replay when the SDK transport closes', async () => {
    const { client, request } = fixture(() => { throw new Error('fixture transport closed') })
    const result = await new FeishuDocumentTools(client, token).execute({
      action: 'doc_insert_blocks', documentId: document, documentRevision: 7, blocks: [{ type: 'text', text: 'sample' }]
    })
    expect(result).toMatchObject({ ok: false, data: { documentId: document, documentRevision: 7, outcome: 'unknown', operationId: expect.any(String) } })
    expect(request).toHaveBeenCalledTimes(1)
  })

  const chooseImage: FeishuAttachmentPicker = async () => ({ name: 'image.png', bytes: Buffer.from('fixture') })
  const chooseFile: FeishuAttachmentPicker = async () => ({ name: 'document.pdf', bytes: Buffer.from('fixture') })
  const attach = { action: 'doc_file_attach', documentId: document, documentRevision: 7 } as const

  it('uploads an image directly to its image block, then binds the SDK file_token', async () => {
    const { client, request } = fixture(
      inserted({ block_id: 'image-block', block_type: 27 }),
      upload,
      ok({ block: { block_id: 'image-block', block_type: 27, image: { token: 'fixture-file-token' } }, document_revision_id: 9 })
    )
    const result = await new FeishuDocumentTools(client, token).execute(attach, chooseImage)
    expect(result).toMatchObject({ ok: true, data: { mediaBlockId: 'image-block', documentRevision: 9 } })
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'POST', url: expect.stringContaining('/medias/upload_all'),
      data: { parent_type: 'docx_image', parent_node: 'image-block', file_name: 'image.png', size: 7, file: expect.any(ReadStream) }
    })
    expect(request.mock.calls[2][0]).toMatchObject({
      method: 'PATCH', params: { document_revision_id: 8 },
      data: { replace_image: { token: 'fixture-file-token' } }
    })
    expectUserIdentity(request)
  })

  it('finds the actual file block inside a view wrapper and does not use the view as media parent', async () => {
    const { client, request } = fixture(
      inserted({ block_id: 'view-block', block_type: 33, children: ['file-block'] }),
      ok({ items: [{ block_id: 'file-block', block_type: 23 }], has_more: false }),
      upload,
      ok({ block: { block_id: 'file-block', block_type: 23, file: { token: 'fixture-file-token' } }, document_revision_id: 9 })
    )
    expect(await new FeishuDocumentTools(client, token).execute(attach, chooseFile)).toMatchObject({
      ok: true, data: { blockId: 'view-block', mediaBlockId: 'file-block' }
    })
    expect(request.mock.calls[1][0].url).toContain('/blocks/view-block/children')
    expect(request.mock.calls[2][0].data).toMatchObject({ parent_type: 'docx_file', parent_node: 'file-block' })
    expect(request.mock.calls[3][0].data).toMatchObject({ replace_file: { token: 'fixture-file-token' } })
    expectUserIdentity(request)
  })

  it('sends a named multipart file with the real HTTP serializer and confirms its bound token', async () => {
    const uploads: Array<{ body: string; contentType?: string; authorization?: string }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let result
      if (req.url?.includes('/medias/upload_all')) {
        uploads.push({
          body: Buffer.concat(chunks).toString('utf8'), contentType: req.headers['content-type'],
          authorization: req.headers.authorization
        })
        result = upload
      } else if (req.method === 'POST') {
        result = inserted({ block_id: 'file-block', block_type: 23 })
      } else if (req.method === 'PATCH') {
        result = ok({ block: { block_id: 'file-block', block_type: 23 }, document_revision_id: 9 })
      } else {
        result = ok({ block: { block_id: 'file-block', block_type: 23, file: { token: 'fixture-file-token' } } })
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const client = new Client({
        appId: 'synthetic-app', appSecret: 'synthetic-secret', domain: `http://127.0.0.1:${port}`
      })
      expect(await new FeishuDocumentTools(client, token).execute(attach, chooseFile)).toMatchObject({
        ok: true, data: { mediaBlockId: 'file-block', documentRevision: 9 }
      })
      expect(uploads).toHaveLength(1)
      expect(uploads[0]).toMatchObject({
        contentType: expect.stringContaining('multipart/form-data; boundary='),
        authorization: `Bearer ${token}`
      })
      expect(uploads[0].body).toContain('name="file"; filename="attachment.pdf"')
      expect(uploads[0].body).toContain('\r\nfixture\r\n')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('returns the created shell after upload rejection and never retries under a tenant token', async () => {
    const { client, request } = fixture(
      inserted({ block_id: 'image-block', block_type: 27 }),
      ok(undefined)
    )
    const result = await new FeishuDocumentTools(client, token).execute(attach, chooseImage)
    expect(result).toMatchObject({
      ok: false, data: { outcome: 'partial', stage: 'upload', blockId: 'image-block', documentRevision: 8 }
    })
    expect(request).toHaveBeenCalledTimes(2)
    expectUserIdentity(request)
  })

  it('stops before binding if the session loses access after the upload', async () => {
    let allowed = true
    const { client, request } = fixture(
      inserted({ block_id: 'image-block', block_type: 27 }),
      () => { allowed = false; return upload }
    )
    expect(await new FeishuDocumentTools(client, token, undefined, () => allowed).execute(attach, chooseImage))
      .toMatchObject({ ok: false, data: { outcome: 'partial', stage: 'bind', blockId: 'image-block' } })
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('Feishu media authorization and file-selection boundary', () => {
  const attach = { action: 'doc_file_attach', documentId: document } as const

  it('requires both scopes before selecting and cancels without contacting the API', async () => {
    const { client, request } = fixture()
    const pick = vi.fn(async () => null)
    const channel = { documentClient: client } as never
    const mediaOnly = new FeishuToolRegistry(() => channel, capability => capability === 'docs.media', async () => token, pick)
    expect(capabilityFor('doc_file_attach')).toBe('docs.media')
    expect(await mediaOnly.executeForSession('session', attach)).toMatchObject({ ok: false, authorizationRequired: 'docs.write' })
    expect(pick).not.toHaveBeenCalled()

    const registry = new FeishuToolRegistry(() => channel, () => true, async () => token, pick)
    await expect(registry.execute(attach)).resolves.toMatchObject({ ok: false })
    await expect(registry.executeForSession('session', { ...attach, localPath: 'synthetic.txt' })).resolves.toMatchObject({ ok: false })
    expect(pick).not.toHaveBeenCalled()
    await expect(registry.executeForSession('session', attach)).resolves.toMatchObject({ ok: false, data: { outcome: 'cancelled' } })
    expect(pick).toHaveBeenCalledWith('session', { documentId: document, parentBlockId: document }, undefined)
    expect(request).not.toHaveBeenCalled()
  })
})
