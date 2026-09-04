import { describe, expect, it } from 'vitest'
import { parseFeishuToolRequest } from './feishuBridge'

describe('parseFeishuToolRequest', () => {
  it('allows only the closed high-level Feishu tool surface', () => {
    expect(parseFeishuToolRequest({ action: 'message_send', chatId: 'oc_1', content: 'hi' })).toMatchObject({ action: 'message_send' })
    expect(parseFeishuToolRequest({ action: 'request', url: 'https://evil.example' })).toBeNull()
    expect(parseFeishuToolRequest({ action: 'message_send', secret: 'should-stay-in-omp' })).toMatchObject({ action: 'message_send' })
  })
})
