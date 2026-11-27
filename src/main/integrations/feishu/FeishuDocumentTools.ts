import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withUserAccessToken, type Client } from '@larksuiteoapi/node-sdk'
import type { FeishuToolRequest, FeishuToolResult } from '../../../shared/connections'

export const FEISHU_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const PAGE_SIZE = 25
const READ_RESULT_BYTES = 19_000
const MAX_DELETE_PAGES = 20
const MAX_BLOCK_TEXT = 20_000
// Each table cell needs a TableCell and a Text descendant. Feishu allows
// up to 1,000 descendants including the table itself.
const MAX_TABLE_CELLS = 499
const TABLE = 31
const TABLE_CELL = 32
const FILE = 23
const IMAGE = 27
const VIEW = 33
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i
const VIDEO_FILE = /\.(?:mp4|mov|m4v|webm)$/i
const TEXT_BLOCK_TYPES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17])
const TEXT_FIELDS = [
  'text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
  'heading7', 'heading8', 'heading9', 'bullet', 'ordered', 'quote', 'todo'
] as const

export interface FeishuAttachmentTarget {
  documentId: string
  parentBlockId: string
}

export interface FeishuAttachment {
  name: string
  bytes: Buffer
}

export type FeishuAttachmentPicker = (
  target: FeishuAttachmentTarget, signal?: AbortSignal
) => Promise<FeishuAttachment | null>

type Docx = Client['docx']['v1']
type ChildPage = NonNullable<Awaited<ReturnType<Docx['documentBlockChildren']['get']>>['data']>
type Block = NonNullable<ChildPage['items']>[number]
type ChildCreate = NonNullable<Parameters<Docx['documentBlockChildren']['create']>[0]>
type NewBlock = NonNullable<NonNullable<ChildCreate['data']>['children']>[number]
type DescendantCreate = NonNullable<Parameters<Docx['documentBlockDescendant']['create']>[0]>
type Descendant = DescendantCreate['data']['descendants'][number]

type ApiResponse<T> = { code?: number; data?: T }
type Operation = 'create' | 'upload' | 'bind'

class DocumentToolError extends Error {}

class DocumentApiError extends DocumentToolError {
  constructor(code: number) {
    super(`飞书拒绝了文档操作（错误码 ${code}）。请检查文档权限、当前版本及参数。`)
  }
}

interface DocumentTarget extends FeishuAttachmentTarget {
  revision?: number
  index?: number
}

interface WriteReceipt {
  documentId: string
  parentBlockId: string
  operationId: string
  documentRevision: number
  blockId?: string
  mediaBlockId?: string
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new DocumentToolError(`${label} 无效。`)
  return value
}

function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function parseTarget(request: FeishuToolRequest): DocumentTarget {
  const documentId = identifier(request.documentId, 'documentId')
  const parentBlockId = request.parentBlockId === undefined ? documentId : identifier(request.parentBlockId, 'parentBlockId')
  const revision = request.documentRevision
  const index = request.index
  if (revision !== undefined && !positiveRevision(revision)) throw new DocumentToolError('documentRevision 必须是有效的文档版本。')
  if (index !== undefined && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < -1)) {
    throw new DocumentToolError('index 必须是非负整数，或使用 -1 追加到末尾。')
  }
  if (typeof index === 'number' && index >= 0 && revision === undefined) {
    throw new DocumentToolError('指定插入位置时，请先读取文档块并传入返回的 documentRevision。')
  }
  return { documentId, parentBlockId, revision, index }
}

function docPath(target: DocumentTarget, blockId = target.parentBlockId) {
  return { document_id: target.documentId, block_id: blockId }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > MAX_BLOCK_TEXT) {
    throw new DocumentToolError(`${label} 必须是长度不超过 ${MAX_BLOCK_TEXT} 的字符串。`)
  }
  return value
}

function textElements(content: string) {
  return { elements: [{ text_run: { content } }] }
}

function plainText(block: Block): string {
  for (const field of TEXT_FIELDS) {
    const content = block[field]
    if (content) return content.elements.map(element => element.text_run?.content ?? '').join('')
  }
  return ''
}

function blockSummary(block: Block, textLimit = 240) {
  const content = plainText(block)
  return {
    block_id: block.block_id, parent_id: block.parent_id, block_type: block.block_type,
    childCount: block.children?.length ?? 0, text: content.slice(0, textLimit),
    ...(content.length > textLimit ? { textTruncated: true } : {})
  }
}

function parseBlocks(value: unknown): NewBlock[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new DocumentToolError('blocks 必须包含 1 到 50 个文档块。')
  }
  return value.map((block, index) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new DocumentToolError(`第 ${index + 1} 个文档块无效。`)
    }
    const spec = block as Record<string, unknown>
    const body = textElements(text(spec.text, `第 ${index + 1} 个块的 text`))
    switch (spec.type) {
      case 'text': return { block_type: 2, text: body }
      case 'bullet': return { block_type: 12, bullet: body }
      case 'number': return { block_type: 13, ordered: body }
      case 'quote': return { block_type: 15, quote: body }
      case 'heading': {
        const level = spec.level
        if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 9) {
          throw new DocumentToolError(`第 ${index + 1} 个标题需要 1 到 9 的整数 level。`)
        }
        return { block_type: 2 + level, [`heading${level}`]: body }
      }
      default: throw new DocumentToolError(`第 ${index + 1} 个文档块类型不受支持。`)
    }
  })
}

function parseTable(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0]) || value[0].length === 0) {
    throw new DocumentToolError('cells 必须是非空的二维字符串数组。')
  }
  const columns = value[0].length
  if (columns > 100 || value.length * columns > MAX_TABLE_CELLS) {
    throw new DocumentToolError(`单次建表最多支持 100 列和 ${MAX_TABLE_CELLS} 个单元格。`)
  }
  return value.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns) throw new DocumentToolError('每一行的列数必须一致。')
    return row.map((cell, columnIndex) => text(cell, `第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`))
  })
}

function expectData<T>(response: ApiResponse<T>): T {
  if (typeof response.code === 'number' && response.code !== 0) throw new DocumentApiError(response.code)
  if (response.code !== 0 || response.data == null) throw new DocumentToolError('飞书未返回可核验的文档结果。')
  return response.data
}

function failed(error: string, data?: unknown): FeishuToolResult {
  return { ok: false, error, ...(data === undefined ? {} : { data }) }
}

/** Document operations always use the caller's Feishu user identity. */
export class FeishuDocumentTools {
  private readonly docx: Docx
  private readonly auth: ReturnType<typeof withUserAccessToken>

  constructor(
    private readonly client: Client,
    userAccessToken: string,
    private readonly signal?: AbortSignal,
    private readonly canExecute?: () => boolean
  ) {
    this.docx = client.docx.v1
    this.auth = withUserAccessToken(userAccessToken)
  }

  async execute(request: FeishuToolRequest, pickAttachment?: FeishuAttachmentPicker): Promise<FeishuToolResult> {
    try {
      this.checkAccess()
      const target = parseTarget(request)
      switch (request.action) {
        case 'doc_blocks': return await this.list(target, request)
        case 'doc_insert_blocks': return await this.insert(target, parseBlocks(request.blocks))
        case 'doc_update_block': return await this.update(target, identifier(request.blockId, 'blockId'), text(request.text, 'text'))
        case 'doc_delete_block': return await this.delete(target, identifier(request.blockId, 'blockId'), request.parentBlockId !== undefined)
        case 'doc_table_fill': return await this.createTable(target, parseTable(request.cells))
        case 'doc_file_attach': return await this.attach(target, pickAttachment)
        default: return failed('不支持的飞书文档操作。')
      }
    } catch (error) {
      if (this.signal?.aborted) return failed('操作已取消。', { outcome: 'cancelled' })
      if (error instanceof DocumentToolError) return failed(error.message)
      throw error
    }
  }

  private checkAccess(): void {
    this.signal?.throwIfAborted()
    if (this.canExecute?.() === false) throw new DocumentToolError('当前会话已结束或无法执行这项飞书文档操作。')
  }

  private async currentRevision(target: DocumentTarget): Promise<number> {
    this.checkAccess()
    if (target.revision !== undefined) return target.revision
    const response = await this.docx.document.get({ path: { document_id: target.documentId } }, this.auth)
    const revision = expectData(response).document?.revision_id
    if (!positiveRevision(revision)) throw new DocumentToolError('飞书未返回当前文档版本。')
    return revision
  }

  private async list(target: DocumentTarget, request: FeishuToolRequest): Promise<FeishuToolResult> {
    const { pageToken, pageSize = PAGE_SIZE, includeDescendants = false } = request
    if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length === 0 || pageToken.length > 1024)) {
      return failed('pageToken 无效。')
    }
    if (pageToken !== undefined && target.revision === undefined) return failed('继续分页时，请沿用上一页返回的 documentRevision。')
    if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      return failed('pageSize 必须是 1 到 50 的整数。')
    }
    if (typeof includeDescendants !== 'boolean') return failed('includeDescendants 必须是布尔值。')
    const documentRevision = await this.currentRevision(target)
    const page = await this.children(target, documentRevision, pageSize, pageToken, includeDescendants)
    if (page.has_more && !page.page_token) return failed('飞书分页结果不完整，请重新读取这一页。')
    const pagination = {
      documentRevision, hasMore: page.has_more === true,
      nextPageToken: page.has_more ? page.page_token : undefined
    }
    // Preserve every block ID in the server page, even when its textual
    // preview must shrink to fit both bridge and extension limits.
    for (const textLimit of [240, 80, 0]) {
      const data = { ...pagination, blocks: page.items?.map(block => blockSummary(block, textLimit)) ?? [] }
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') <= READ_RESULT_BYTES) return { ok: true, data }
    }
    return failed('此页文档块过多，请减小 pageSize 后重新读取。')
  }

  private async children(target: DocumentTarget, revision: number, pageSize: number, pageToken?: string, includeDescendants = false): Promise<ChildPage> {
    this.checkAccess()
    return expectData(await this.docx.documentBlockChildren.get({
      path: docPath(target),
      params: {
        document_revision_id: revision, page_size: pageSize,
        page_token: pageToken, with_descendants: includeDescendants
      }
    }, this.auth))
  }

  private async insert(target: DocumentTarget, children: NewBlock[]): Promise<FeishuToolResult> {
    const revision = await this.currentRevision(target)
    return this.write(target, revision, params => this.docx.documentBlockChildren.create({
      path: docPath(target), params, data: { children, index: target.index }
    }, this.auth), data => {
      if (data.children?.length !== children.length || data.children.some(block => !block.block_id)) {
        throw new DocumentToolError('飞书未返回可核验的新块 ID。')
      }
      return { blocks: data.children.map(block => blockSummary(block)) }
    })
  }

  private async update(target: DocumentTarget, blockId: string, content: string): Promise<FeishuToolResult> {
    const revision = await this.currentRevision(target)
    this.checkAccess()
    const data = expectData(await this.docx.documentBlock.get({
      path: docPath(target, blockId), params: { document_revision_id: revision }
    }, this.auth))
    const blockType = data.block?.block_type
    if (data.block?.block_id !== blockId || blockType === undefined || !TEXT_BLOCK_TYPES.has(blockType)) {
      return failed('该块不可编辑。请指定文字、标题、列表、引用或待办块。')
    }
    return this.write(target, revision, params => this.docx.documentBlock.patch({
      path: docPath(target, blockId), params, data: { update_text_elements: textElements(content) }
    }, this.auth), data => {
      if (data.block?.block_id !== blockId || data.block.block_type !== blockType) {
        throw new DocumentToolError('飞书未返回可核验的修改结果。')
      }
      return { block: blockSummary(data.block) }
    }, blockId)
  }

  private async delete(target: DocumentTarget, blockId: string, hasParent: boolean): Promise<FeishuToolResult> {
    if (blockId === target.documentId) return failed('不能删除文档根块。')
    const revision = await this.currentRevision(target)
    this.checkAccess()
    const block = expectData(await this.docx.documentBlock.get({
      path: docPath(target, blockId), params: { document_revision_id: revision }
    }, this.auth)).block
    if (block?.block_id !== blockId || !block.parent_id) return failed('未找到目标块及其父块。')
    if (hasParent && block.parent_id !== target.parentBlockId) return failed('父块与当前文档结构不符，请重新读取。')
    const parent = { ...target, parentBlockId: identifier(block.parent_id, '父块 ID') }
    let start = 0
    let pageToken: string | undefined
    for (let pageNumber = 0; pageNumber < MAX_DELETE_PAGES; pageNumber++) {
      const page = await this.children(parent, revision, 100, pageToken)
      const blocks = page.items ?? []
      const index = blocks.findIndex(item => item.block_id === blockId)
      if (index >= 0) {
        const startIndex = start + index
        return this.write(parent, revision, params => this.docx.documentBlockChildren.batchDelete({
          path: docPath(parent), params, data: { start_index: startIndex, end_index: startIndex + 1 }
        }, this.auth), () => ({ deleted: true }), blockId)
      }
      if (!page.has_more) break
      if (!page.page_token || page.page_token === pageToken) break
      pageToken = page.page_token
      start += blocks.length
    }
    return failed('无法在父块中定位目标块。请重新读取文档，未执行删除。')
  }

  private async createTable(target: DocumentTarget, rows: string[][]): Promise<FeishuToolResult> {
    const revision = await this.currentRevision(target)
    const tableId = 'table'
    const cellIds: string[] = []
    const descendants: Descendant[] = [{
      block_id: tableId, block_type: TABLE, children: cellIds,
      table: { property: { row_size: rows.length, column_size: rows[0].length, header_row: true } }
    }]
    for (const [index, content] of rows.flat().entries()) {
      const cellId = `cell_${index}`
      const textId = `text_${index}`
      cellIds.push(cellId)
      descendants.push(
        { block_id: cellId, block_type: TABLE_CELL, children: [textId], table_cell: {} },
        { block_id: textId, block_type: 2, text: textElements(content) }
      )
    }
    return this.write(target, revision, params => this.docx.documentBlockDescendant.create({
      path: docPath(target), params,
      data: { children_id: [tableId], index: target.index, descendants }
    }, this.auth), data => {
      const tableBlockId = data.block_id_relations?.find(relation => relation.temporary_block_id === tableId)?.block_id
        ?? data.children?.find(block => block.block_type === TABLE)?.block_id
      if (!tableBlockId) throw new DocumentToolError('飞书未返回可核验的新表格 ID。')
      return { tableBlockId, rows: rows.length, columns: rows[0].length }
    })
  }

  private async attach(target: DocumentTarget, pickAttachment?: FeishuAttachmentPicker): Promise<FeishuToolResult> {
    if (!pickAttachment) return failed('请从本机投手对话选择要上传的附件。')
    const file = await pickAttachment(
      { documentId: target.documentId, parentBlockId: target.parentBlockId }, this.signal
    )
    this.checkAccess()
    if (!file) return failed('已取消选择附件。', { outcome: 'cancelled' })
    if (!file.name || file.name.length > 250 || /[\\/\u0000-\u001f]/.test(file.name) || !Buffer.isBuffer(file.bytes)
      || file.bytes.length === 0 || file.bytes.length > FEISHU_MAX_ATTACHMENT_BYTES) {
      return failed('附件无效。请选择有效的非空文件，大小不得超过 20 MB。')
    }
    // The SDK accepts Buffer, but its current multipart serializer does not
    // add a filename to that part. A private stream snapshot emits a file
    // part without sourcing any new path or rereading the user's original.
    const staging = await mkdtemp(path.join(tmpdir(), 'toushou-feishu-upload-'))
    const safeExtension = /\.[a-zA-Z0-9]{1,10}$/.exec(file.name)?.[0] ?? '.bin'
    const stagedPath = path.join(staging, 'attachment' + safeExtension)
    try {
      await writeFile(stagedPath, file.bytes, { flag: 'wx', mode: 0o600 })
      return await this.attachStagedFile(target, file, stagedPath)
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(() => undefined)
    }
  }

  private async attachStagedFile(target: DocumentTarget, file: FeishuAttachment, stagedPath: string): Promise<FeishuToolResult> {
    const revision = await this.currentRevision(target)
    const receipt: WriteReceipt = {
      documentId: target.documentId, parentBlockId: target.parentBlockId,
      documentRevision: revision, operationId: randomUUID()
    }
    const isImage = IMAGE_FILE.test(file.name)
    const mediaType = isImage ? IMAGE : FILE
    let stage: Operation = 'create'
    this.checkAccess()
    try {
      const created = expectData(await this.docx.documentBlockChildren.create({
        path: docPath(target), params: { document_revision_id: revision, client_token: receipt.operationId },
        data: {
          index: target.index,
          children: [isImage ? { block_type: IMAGE, image: {} } : {
            block_type: FILE, file: VIDEO_FILE.test(file.name) ? { view_type: 2 } : {}
          }]
        }
      }, this.auth))
      const outer = created.children?.[0]
      receipt.blockId = outer?.block_id
      stage = 'upload'
      if (!outer?.block_id || !positiveRevision(created.document_revision_id)) {
        throw new DocumentToolError('飞书未返回可核验的附件块或文档版本。')
      }
      receipt.documentRevision = created.document_revision_id
      if (outer.block_type === mediaType) {
        receipt.mediaBlockId = outer.block_id
        if (mediaType === FILE && outer.parent_id && outer.parent_id !== target.parentBlockId) {
          receipt.blockId = outer.parent_id
        }
      } else if (mediaType === FILE && outer.block_type === VIEW) {
        const inner = await this.children({ ...target, parentBlockId: outer.block_id }, receipt.documentRevision, 10)
        const matches = inner.items?.filter(item => item.block_type === FILE) ?? []
        if (matches.length === 1 && !inner.has_more) receipt.mediaBlockId = matches[0].block_id
      }
      if (!receipt.mediaBlockId) throw new DocumentToolError('无法确认飞书附件块 ID。')

      this.checkAccess()
      const uploaded = await this.uploadAttachment(target, file, stagedPath, receipt.mediaBlockId, isImage)
      if (!uploaded?.file_token) {
        throw new DocumentToolError('飞书未返回素材 ID。请检查附件上传权限与目标文档权限。')
      }
      stage = 'bind'
      this.checkAccess()
      const bound = expectData(await this.docx.documentBlock.patch({
        path: docPath(target, receipt.mediaBlockId),
        params: { document_revision_id: receipt.documentRevision, client_token: randomUUID() },
        data: isImage
          ? { replace_image: { token: uploaded.file_token } }
          : { replace_file: { token: uploaded.file_token } }
      }, this.auth))
      if (!positiveRevision(bound.document_revision_id) || bound.block?.block_id !== receipt.mediaBlockId) {
        throw new DocumentToolError('飞书未返回可核验的附件绑定结果。')
      }
      receipt.documentRevision = bound.document_revision_id
      this.checkAccess()
      const boundToken = isImage ? bound.block.image?.token : bound.block.file?.token
      if (boundToken !== uploaded.file_token) {
        const verified = expectData(await this.docx.documentBlock.get({
          path: docPath(target, receipt.mediaBlockId), params: { document_revision_id: receipt.documentRevision }
        }, this.auth)).block
        this.checkAccess()
        const verifiedToken = isImage ? verified?.image?.token : verified?.file?.token
        if (verified?.block_id !== receipt.mediaBlockId || verifiedToken !== uploaded.file_token) {
          throw new DocumentToolError('回读未确认附件已绑定。')
        }
      }
      return {
        ok: true,
        data: { ...receipt, fileName: file.name, size: file.bytes.length }
      }
    } catch (error) {
      if (stage === 'create' && error instanceof DocumentApiError) return failed(error.message)
      const message = error instanceof DocumentToolError ? error.message : '附件操作未收到飞书确认。'
      return failed(
        `${message} 请先回读目标文档核对已有附件块，确认后再继续。`,
        { ...receipt, outcome: stage === 'create' ? 'unknown' : 'partial', stage }
      )
    }
  }

  private async uploadAttachment(target: DocumentTarget, file: FeishuAttachment, stagedPath: string, mediaBlockId: string, isImage: boolean) {
    const stream = createReadStream(stagedPath)
    try {
      return await this.client.drive.v1.media.uploadAll({
        data: {
          file_name: file.name, size: file.bytes.length, file: stream,
          parent_type: isImage ? 'docx_image' : 'docx_file', parent_node: mediaBlockId,
          extra: JSON.stringify({ drive_route_token: target.documentId })
        }
      }, this.auth)
    } finally {
      if (!stream.closed) {
        const closed = new Promise<void>(resolve => stream.once('close', resolve))
        stream.destroy()
        await closed
      }
    }
  }

  private async write<T extends { document_revision_id?: number }>(
    target: DocumentTarget, revision: number,
    request: (params: { document_revision_id: number; client_token: string }) => Promise<ApiResponse<T>>,
    project: (data: T) => object,
    blockId?: string
  ): Promise<FeishuToolResult> {
    this.checkAccess()
    const operationId = randomUUID()
    const location = { documentId: target.documentId, parentBlockId: target.parentBlockId, operationId, blockId }
    let lastRevision = revision
    try {
      const data = expectData(await request({ document_revision_id: revision, client_token: operationId }))
      if (!positiveRevision(data.document_revision_id)) throw new DocumentToolError('飞书未返回操作后的文档版本。')
      lastRevision = data.document_revision_id
      this.checkAccess()
      return { ok: true, data: { ...location, ...project(data), documentRevision: lastRevision } }
    } catch (error) {
      if (error instanceof DocumentApiError) return failed(error.message)
      return failed(
        '飞书写入结果未确认。请回读目标文档核对结果后再重试。',
        { ...location, documentRevision: lastRevision, outcome: 'unknown' }
      )
    }
  }
}
