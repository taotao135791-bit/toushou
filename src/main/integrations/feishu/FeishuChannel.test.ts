import { withUserAccessToken, type HttpInstance } from '@larksuiteoapi/node-sdk'
import { describe, expect, it, vi } from 'vitest'
import { FeishuChannel, parseFeishuMessage } from './FeishuChannel'

describe('parseFeishuMessage', () => {
  it('normalizes a text mention and preserves thread identity', () => {
    const message = parseFeishuMessage({
      event: {
        message: {
          message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group',
          root_id: 'om_root', thread_id: 'omt_1', create_time: '1720000000',
          content: JSON.stringify({ text: '@投手 看看今天的广告数据' }),
          mentions: [{ is_bot: true }]
        },
        sender: { sender_id: { open_id: 'ou_user' } }
      }
    })
    expect(message).toMatchObject({
      messageId: 'om_1', chatId: 'oc_1', chatType: 'group', senderId: 'ou_user',
      content: '@投手 看看今天的广告数据', mentionedBot: true, rootId: 'om_root', threadId: 'omt_1'
    })
    expect(message?.createTime).toBe(1720000000000)
  })

  it('extracts image and file resource hints without downloading them', () => {
    const image = parseFeishuMessage({
      event: { message: {
        message_id: 'om_image', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image',
        content: JSON.stringify({ image_key: 'img_key' })
      }, sender: { sender_id: { open_id: 'ou_owner' } } }
    })
    const file = parseFeishuMessage({
      event: { message: {
        message_id: 'om_file', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'file',
        content: JSON.stringify({ file_key: 'file_key', file_name: 'report.csv' })
      }, sender: { sender_id: { open_id: 'ou_owner' } } }
    })
    expect(image?.resources).toEqual([{ type: 'image', fileKey: 'img_key', fileName: undefined }])
    expect(file?.resources).toEqual([{ type: 'file', fileKey: 'file_key', fileName: 'report.csv' }])
  })
})

it('keeps document SDK diagnostics out of logs and disables implicit tenant authentication', async () => {
  const channel = new FeishuChannel({
    appId: 'synthetic-app', appSecret: 'synthetic-secret', brand: 'lark', savedAt: 0
  }, { onMessage: () => {} })
  const failure = new Error('synthetic sensitive diagnostic')
  const httpInstance = { request: vi.fn(async () => { throw failure }) } as unknown as HttpInstance
  channel.rawClient.httpInstance = httpInstance
  const documents = channel.documentClient
  expect(channel.documentClient).toBe(documents)
  expect(documents.domain).toBe(channel.rawClient.domain)
  const access = vi.spyOn(documents.tokenManager, 'getTenantAccessToken')
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    expect((await documents.formatPayload()).headers).not.toHaveProperty('Authorization')
    await expect(documents.docx.v1.document.get(
      { path: { document_id: 'synthetic-doc' } }, withUserAccessToken('fixture-token')
    )).rejects.toBe(failure)
    expect(access).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  } finally {
    access.mockRestore()
    consoleError.mockRestore()
  }
})
