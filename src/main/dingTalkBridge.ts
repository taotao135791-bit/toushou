import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { serializeBoundedJson } from '../shared/boundedJson'
import type { DingTalkReadError, DingTalkReadRequest, DingTalkReadResult } from '../shared/connections'

const MAX_BODY_BYTES = 4_096
const MAX_RESULT_BYTES = 48_000
const QUERY_TIMEOUT_MS = 25_000
const MAX_LIVE_CAPABILITIES = 200
export const DINGTALK_TOOLS_ENV_KEY = 'TOUSHOU_DINGTALK'

function parseDocumentId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null
  const text = value.trim()
  if (/^[A-Za-z0-9_-]{1,200}$/.test(text)) return text
  try {
    const url = new URL(text)
    if (url.origin !== 'https://alidocs.dingtalk.com' || url.username || url.password) return null
    return /^\/i\/nodes\/([A-Za-z0-9_-]{1,200})\/?$/.exec(url.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

export function parseDingTalkReadRequest(raw: unknown): DingTalkReadRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2) return null
  const input = raw as Record<string, unknown>
  if (input.action === 'search_messages' || input.action === 'search_documents') {
    if (typeof input.query !== 'string' || input.query.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(input.query)) return null
    const query = input.query.trim()
    return query ? { action: input.action, query } : null
  }
  if (input.action === 'read_document') {
    const documentId = parseDocumentId(input.documentId)
    return documentId ? { action: input.action, documentId } : null
  }
  return null
}

interface SessionCapability {
  sessionId: string
  lifetime: AbortController
}

let port: number | null = null
let ready: Promise<void> | null = null
const capabilities = new Map<string, SessionCapability>()

export function initDingTalkBridge(): Promise<void> {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    const server = createServer({ requestTimeout: 10_000 }, (request, response) => void handle(request, response))
    server.once('error', error => {
      port = null
      ready = null
      reject(error)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        ready = null
        reject(new Error('DingTalk bridge could not bind a loopback port'))
        return
      }
      server.unref()
      port = address.port
      resolve()
    })
  })
  return ready
}

export function dingTalkBridgeEnv(sessionId: string): Record<string, string> {
  if (port === null || capabilities.size >= MAX_LIVE_CAPABILITIES) return {}
  const token = randomBytes(24).toString('hex')
  capabilities.set(token, { sessionId, lifetime: new AbortController() })
  return { [DINGTALK_TOOLS_ENV_KEY]: `http://127.0.0.1:${port}/${token}` }
}

export function revokeDingTalkBridgeTokens(sessionId: string): void {
  for (const [token, capability] of capabilities) {
    if (capability.sessionId !== sessionId) continue
    capability.lifetime.abort()
    capabilities.delete(token)
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const token = request.url?.slice(1) ?? ''
  const capability = capabilities.get(token)
  if (!capability || request.method !== 'POST' || request.headers.origin || request.headers['content-type'] !== 'application/json') {
    return send(response, 403, { ok: false, error: 'forbidden' })
  }

  const closed = new AbortController()
  response.once('close', () => { if (!response.writableEnded) closed.abort() })
  const signal = AbortSignal.any([capability.lifetime.signal, closed.signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)])
  try {
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        response.setHeader('connection', 'close')
        return send(response, 413, { ok: false, error: 'invalid-input' })
      }
      chunks.push(chunk)
    }
    let payload: unknown
    try { payload = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) } catch {
      return send(response, 400, { ok: false, error: 'invalid-input' })
    }
    const tool = parseDingTalkReadRequest(payload)
    if (!tool) return send(response, 400, { ok: false, error: 'invalid-input' })

    const { getSession, getSessionBridgeAccess } = await import('./omp')
    const liveWorkspace = () => {
      const access = getSessionBridgeAccess(capability.sessionId)
      const session = getSession(capability.sessionId)
      // Feishu-origin and scheduled task sessions must not read a desktop user's DingTalk data.
      return access && session && !access.remoteReadonly && !session.origin ? access.cwd : null
    }
    const workspace = liveWorkspace()
    if (!workspace || signal.aborted) return send(response, 403, { ok: false, error: 'forbidden' })

    const { dingTalkConnectionManager } = await import('./integrations/dingtalk/DingTalkConnectionManager')
    if (signal.aborted || workspace !== liveWorkspace()) return send(response, 403, { ok: false, error: 'forbidden' })
    const result = await dingTalkConnectionManager.read(tool, signal)
    if (capability.lifetime.signal.aborted || workspace !== liveWorkspace()) {
      return send(response, 403, { ok: false, error: 'forbidden' })
    }
    if (signal.aborted) return send(response, 200, { ok: false, error: 'read-failed' })
    return send(response, 200, projectResult(result))
  } catch {
    return send(response, 200, { ok: false, error: 'read-failed' })
  }
}

const READ_ERRORS = new Set<DingTalkReadError>([
  'not-connected', 'invalid-input', 'cli-unavailable', 'organization-access-required', 'not-authorized', 'permission-denied', 'network', 'read-failed'
])

function projectResult(result: DingTalkReadResult): Record<string, unknown> {
  if (result.ok) return { ok: true, source: 'DingTalk', data: result.data }
  return { ok: false, error: READ_ERRORS.has(result.error) ? result.error : 'read-failed' }
}

function send(response: ServerResponse, status: number, result: Record<string, unknown>): void {
  if (response.destroyed) return
  const body = serializeBoundedJson(result, MAX_RESULT_BYTES)
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(body)
}
