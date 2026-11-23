import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DingTalkStream, type DingTalkIncomingMessage } from './DingTalkStream'

const credentials = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }
const officialEndpoint = 'wss://wss-open-connection.dingtalk.com:443/connect'
const officialWebhook = 'https://oapi.dingtalk.com/robot/sendBySession?session=synthetic-session'
const topic = '/v1.0/im/bot/messages/get'

function message(overrides: Record<string, unknown> = {}) {
  return {
    msgId: 'message-1',
    conversationId: 'conversation-1',
    conversationType: '2',
    conversationTitle: '优化组',
    senderId: 'account-1',
    senderStaffId: 'staff-1',
    senderNick: '投放同学',
    isInAtList: true,
    msgtype: 'text',
    text: { content: '  过去七天投放怎么样？  ' },
    sessionWebhook: officialWebhook,
    sessionWebhookExpiredTime: Date.now() + 60_000,
    ...overrides
  }
}

function sendFrame(socket: WebSocket, type: string, frameTopic: string, data: string, messageId?: string) {
  socket.send(JSON.stringify({ specVersion: '1.0', type, headers: { topic: frameTopic, messageId }, data }))
}

function nextFrame(socket: WebSocket) {
  return once(socket, 'message').then(([data]) => JSON.parse(data.toString()))
}

describe('DingTalk Stream transport', () => {
  let server: WebSocketServer
  let localEndpoint: string
  let transport: DingTalkStream | undefined

  beforeEach(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected a loopback TCP listener')
    localEndpoint = `ws://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    transport?.close()
    transport = undefined
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })

  function setup(fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ endpoint: officialEndpoint, ticket: 'once+/=' }))) {
    const callbacks = { onMessage: vi.fn<(event: DingTalkIncomingMessage) => void>(), onDisconnect: vi.fn<() => void>() }
    // Keep production URL validation active. Only the TCP connection is redirected to the fixture.
    const createSocket = vi.fn((_: URL, options: WebSocket.ClientOptions) => new WebSocket(localEndpoint, options))
    const stream = new DingTalkStream(credentials, callbacks, fetchRequest, createSocket)
    transport = stream
    return { callbacks, fetchRequest, createSocket, stream }
  }

  async function connect(stream: DingTalkStream): Promise<WebSocket> {
    const incoming = once(server, 'connection')
    await stream.connect()
    const [socket] = await incoming
    return socket
  }

  it('registers the official topic, presents the ticket only to the approved WSS host, and connects once', async () => {
    const { fetchRequest, createSocket, stream } = setup()
    const first = stream.connect()
    expect(stream.connect()).toBe(first)
    await first

    expect(fetchRequest).toHaveBeenCalledOnce()
    const [url, request] = fetchRequest.mock.calls[0]
    expect(url).toBe('https://api.dingtalk.com/v1.0/gateway/connections/open')
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(String(request?.body))).toEqual({ ...credentials, subscriptions: [{ type: 'CALLBACK', topic }] })
    expect(createSocket).toHaveBeenCalledOnce()
    expect(createSocket.mock.calls[0][0].href).toBe('wss://wss-open-connection.dingtalk.com/connect?ticket=once%2B%2F%3D')
    expect(createSocket.mock.calls[0][1]).toMatchObject({ followRedirects: false, maxPayload: 256 * 1024, handshakeTimeout: 12_000 })
  })

  it('echoes DingTalk system pings and acknowledges duplicate messages without routing them twice', async () => {
    const { callbacks, fetchRequest, stream } = setup()
    const socket = await connect(stream)
    const pingResponse = nextFrame(socket)
    sendFrame(socket, 'SYSTEM', 'ping', '{"opaque":"ping-1"}', 'ping-frame')
    expect(await pingResponse).toEqual({
      code: 200, message: 'OK', headers: { messageId: 'ping-frame', contentType: 'application/json' }, data: '{"opaque":"ping-1"}'
    })

    const original = message()
    const callbackResponse = nextFrame(socket)
    sendFrame(socket, 'CALLBACK', topic, JSON.stringify(original), 'push-1')
    expect(await callbackResponse).toEqual({
      code: 200, message: 'OK', headers: { messageId: 'push-1', contentType: 'application/json' }, data: '{"response":null}'
    })
    expect(callbacks.onMessage).toHaveBeenCalledWith({
      id: 'message-1', conversationId: 'conversation-1', conversationType: 'group', conversationName: '优化组',
      senderId: 'account-1', senderName: '投放同学', text: '过去七天投放怎么样？',
      replyUrl: officialWebhook, replyExpiresAt: original.sessionWebhookExpiredTime
    })

    const duplicateResponse = nextFrame(socket)
    sendFrame(socket, 'CALLBACK', topic, JSON.stringify(original), 'push-retry')
    expect((await duplicateResponse).headers.messageId).toBe('push-retry')
    expect(callbacks.onMessage).toHaveBeenCalledOnce()

    fetchRequest.mockResolvedValueOnce(Response.json({ errcode: 0, errmsg: 'ok' }))
    await stream.reply(callbacks.onMessage.mock.calls[0][0], '已查到消耗和点击。')
    const [url, request] = fetchRequest.mock.calls[1]
    expect(String(url)).toBe(officialWebhook)
    expect(request?.redirect).toBe('error')
    expect(JSON.parse(String(request?.body))).toEqual({ msgtype: 'text', text: { content: '已查到消耗和点击。' } })
  })

  it('accepts direct messages and filters unsupported groups, content, and webhook destinations', async () => {
    const { callbacks, stream } = setup()
    const socket = await connect(stream)
    const ignored = [
      message({ isInAtList: false }),
      message({ msgtype: 'picture' }),
      message({ sessionWebhook: 'https://oapi.dingtalk.com@localhost/robot/sendBySession?session=bad' }),
      message({ sessionWebhook: 'https://oapi.dingtalk.com/robot/send?session=wrong-path' }),
      message({ sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession' }),
      message({ sessionWebhookExpiredTime: null })
    ]
    for (const [index, payload] of ignored.entries()) {
      const ack = nextFrame(socket)
      sendFrame(socket, 'CALLBACK', topic, JSON.stringify(payload), `ignored-${index}`)
      expect((await ack).code).toBe(200)
    }
    expect(callbacks.onMessage).not.toHaveBeenCalled()

    const directAck = nextFrame(socket)
    sendFrame(socket, 'CALLBACK', topic, JSON.stringify(message({ conversationType: '1', isInAtList: undefined })), 'direct')
    await directAck
    expect(callbacks.onMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationType: 'direct' }))
  })

  it('does not answer the server disconnect notification and invokes the manager on transport loss', async () => {
    const { callbacks, stream } = setup()
    const socket = await connect(stream)
    const responses: string[] = []
    socket.on('message', (data) => responses.push(data.toString()))
    sendFrame(socket, 'SYSTEM', 'disconnect', '{"reason":"connection is expired"}')
    const heartbeat = nextFrame(socket)
    sendFrame(socket, 'SYSTEM', 'ping', '{}', 'still-connected')
    expect((await heartbeat).headers.messageId).toBe('still-connected')
    expect(responses).toHaveLength(1)
    socket.close()
    await vi.waitFor(() => expect(callbacks.onDisconnect).toHaveBeenCalledOnce())
    stream.close()
    expect(callbacks.onDisconnect).toHaveBeenCalledOnce()
  })

  it('terminates an explicitly closed transport without starting a reconnect', async () => {
    const { callbacks, stream } = setup()
    const socket = await connect(stream)
    const closed = once(socket, 'close')
    stream.close()
    await closed
    expect(callbacks.onDisconnect).not.toHaveBeenCalled()
  })

  it('aborts a pending ticket request before creating a socket', async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockImplementation((_url, request) => new Promise((_resolve, reject) => {
      request?.signal?.addEventListener('abort', () => reject(new Error('aborted request')), { once: true })
    }))
    const { callbacks, createSocket, stream } = setup(fetchRequest)
    const connecting = stream.connect()
    expect(fetchRequest).toHaveBeenCalledOnce()
    stream.close()
    await expect(connecting).rejects.toMatchObject({ code: 'cancelled' })
    expect(createSocket).not.toHaveBeenCalled()
    expect(callbacks.onDisconnect).not.toHaveBeenCalled()
  })

  it('sanitizes provider errors and refuses untrusted ticket destinations', async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'synthetic-secret' }, { status: 403 }))
    const first = setup(fetchRequest)
    await expect(first.stream.connect()).rejects.toMatchObject({ code: 'credentials', message: expect.not.stringContaining('synthetic-secret') })
    expect(first.createSocket).not.toHaveBeenCalled()
    first.stream.close()

    fetchRequest.mockResolvedValueOnce(Response.json({ endpoint: 'wss://wss-open-connection.dingtalk.com.example.test/connect', ticket: 'sensitive' }))
    const second = setup(fetchRequest)
    await expect(second.stream.connect()).rejects.toMatchObject({ code: 'protocol', message: expect.not.stringContaining('sensitive') })
    expect(second.createSocket).not.toHaveBeenCalled()
  })

  it('rejects expired responses locally and reports a DingTalk payload rejection', async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errcode: 310000, errmsg: 'sensitive session' }))
    const { stream } = setup(fetchRequest)
    const original: DingTalkIncomingMessage = {
      id: 'message-1', conversationId: 'conversation-1', conversationType: 'direct', senderId: 'account-1',
      text: '你好', replyUrl: officialWebhook, replyExpiresAt: Date.now() - 1
    }
    await expect(stream.reply(original, '你好')).rejects.toMatchObject({ code: 'reply-expired' })
    expect(fetchRequest).not.toHaveBeenCalled()
    await expect(stream.reply({ ...original, replyExpiresAt: Date.now() + 60_000 }, '你好')).rejects.toMatchObject({
      code: 'reply-failed', message: expect.not.stringContaining('sensitive session')
    })
  })
})
