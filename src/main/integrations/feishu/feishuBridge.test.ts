import { describe, expect, it } from 'vitest'
import { parseFeishuToolRequest } from './feishuBridge'

describe('parseFeishuToolRequest', () => {
  it('allows only the closed high-level Feishu tool surface', () => {
    expect(parseFeishuToolRequest({ action: 'message_send', chatId: 'oc_1', content: 'hi' })).toMatchObject({ action: 'message_send' })
    expect(parseFeishuToolRequest({ action: 'request', url: 'https://evil.example' })).toBeNull()
    expect(parseFeishuToolRequest({ action: 'message_send', secret: 'should-stay-in-omp' })).toMatchObject({ action: 'message_send' })
  })

  it('admits native document tools without letting the attachment request name local data', () => {
    expect(parseFeishuToolRequest({ action: 'doc_list' })).toEqual({ action: 'doc_list' })
    expect(parseFeishuToolRequest({ action: 'doc_search', query: 'sample' })).toEqual({ action: 'doc_search', query: 'sample' })
    for (const action of ['doc_blocks', 'doc_insert_blocks', 'doc_update_block', 'doc_delete_block', 'doc_table_fill']) {
      expect(parseFeishuToolRequest({ action, documentId: 'doc_test' })).toMatchObject({ action })
    }
    const request = { action: 'doc_file_attach', documentId: 'doc_test', parentBlockId: 'block_test', index: 1, documentRevision: 7 }
    expect(parseFeishuToolRequest(request)).toEqual(request)
    for (const field of ['path', 'localPath', 'filename', 'bytes', 'content', 'uploadUrl']) {
      expect(parseFeishuToolRequest({ ...request, [field]: 'untrusted' })).toBeNull()
    }
  })
})
