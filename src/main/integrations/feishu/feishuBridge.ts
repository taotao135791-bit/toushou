import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { FeishuToolRequest } from '../../../shared/connections'

const MAX_BODY_BYTES = 64 * 1024
export const FEISHU_TOOLS_ENV_KEY = 'TOUSHOU_FEISHU'

const ACTIONS = new Set<FeishuToolRequest['action']>([
  'message_send', 'message_reply', 'message_read', 'message_search',
  'doc_read', 'doc_create', 'doc_append', 'sheets_read', 'sheets_write', 'sheets_create',
  'bitable_read', 'bitable_upsert', 'bitable_query'
])

export function parseFeishuToolRequest(raw: unknown): FeishuToolRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  return typeof value.action === 'string' && ACTIONS.has(value.action as FeishuToolRequest['action'])
    ? { ...value, action: value.action as FeishuToolRequest['action'] }
    : null
}

let port: number | null = null
let ready: Promise<void> | null = null
const tokens = new Map<string, string>()

export function initFeishuBridge(): Promise<void> {
  if (port !== null) return Promise.resolve()
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    const server = createServer((request, response) => void handle(request, response))
    const fail = (error: Error) => {
      port = null
      ready = null
      reject(error)
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return fail(new Error('Feishu bridge did not receive a port'))
      port = address.port
      resolve()
    })
  })
  return ready
}

export function feishuBridgeEnv(sessionId: string): Record<string, string> {
  if (port === null) return {}
  const token = randomBytes(24).toString('hex')
  tokens.set(token, sessionId)
  return { [FEISHU_TOOLS_ENV_KEY]: `http://127.0.0.1:${port}/${token}` }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const token = (request.url ?? '').replace(/^\//, '')
  const sessionId = tokens.get(token)
  if (request.method !== 'POST' || !sessionId) return json(response, 403, { ok: false, error: 'forbidden' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return json(response, 413, { ok: false, error: 'request-too-large' })
    chunks.push(buffer)
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return json(response, 400, { ok: false, error: 'bad-json' })
  }
  const tool = parseFeishuToolRequest(raw)
  if (!tool) return json(response, 400, { ok: false, error: 'unsupported-action' })
  // Load the manager only for an actual call so OmpProcess can import the
  // bridge environment without creating an OMP ↔ integration cycle.
  const { feishuConnectionManager } = await import('./FeishuConnectionManager')
  const result = await feishuConnectionManager.executeTool(sessionId, tool)
  return json(response, 200, result)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body).slice(0, 30_000))
}
