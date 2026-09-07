import { describe, expect, it } from 'vitest'
import { parseFeishuMessage } from './FeishuChannel'

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
