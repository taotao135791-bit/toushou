import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { SessionNameOptions, SessionNamingResult } from '../shared/types'

/** This bridge changes one session's UI metadata only, including in readonly mode. */
export interface SessionTopicBridgeDeps {
  getSession: (id: string) => { title: string; titleSource?: 'auto' | 'manual' } | undefined
  getRevision: (id: string) => number
  nameSession: (id: string, title: string, options: SessionNameOptions) => Promise<SessionNamingResult | null>
}

export type SessionTopicRequest = { action: 'context' } | { action: 'topic'; title: string; revision: number }
export function parseSessionTopicRequest(raw: unknown): SessionTopicRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.action === 'context') return { action: 'context' }
  if (value.action !== 'topic' || typeof value.title !== 'string' || value.title.length > 240 || !value.title.trim()) return null
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return null
  return { action: 'topic', title: value.title, revision: value.revision as number }
}

/** Pure dispatcher: identity always comes from Main's per-process token. */
export async function dispatchSessionTopic(deps: SessionTopicBridgeDeps, sessionId: string, request: SessionTopicRequest): Promise<Record<string, unknown>> {
  const session = deps.getSession(sessionId)
  if (!session) return { ok: false, error: 'no-session' }
  const revision = deps.getRevision(sessionId)
  if (request.action === 'context') return { ok: true, revision, manual: session.titleSource === 'manual' }
  if (request.revision !== revision) return { ok: false, error: 'stale-topic' }
  try {
    const result = await deps.nameSession(sessionId, request.title, { source: 'auto', revision: request.revision })
    return result ? { ok: true, ...result } : { ok: false, error: 'topic-not-updated' }
  } catch { return { ok: false, error: 'topic-unavailable' } }
}

let server: Server | undefined
let port: number | undefined
let ready: Promise<void> | undefined
let dependencies: SessionTopicBridgeDeps | undefined
const tokens = new Map<string, string>()

export function initSessionTopicBridge(deps?: SessionTopicBridgeDeps): Promise<void> {
  if (deps) dependencies = deps
  if (port !== undefined) return Promise.resolve()
  if (ready) return ready
  ready = new Promise<void>((resolve, reject) => {
    server = createServer((request, response) => void handle(request, response))
    server.once('error', () => { port = undefined; ready = undefined; reject(new Error('session-topic-bridge-unavailable')) })
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (!address || typeof address === 'string') { ready = undefined; reject(new Error('session-topic-bridge-unavailable')); return }
      port = address.port
      resolve()
    })
  })
  return ready
}

export function sessionTopicBridgeEnv(sessionId: string): Record<string, string> {
  if (port === undefined) return {}
  // Reissuing for a session revokes its earlier process token.
  for (const [token, id] of tokens) if (id === sessionId) tokens.delete(token)
  const token = randomBytes(24).toString('hex')
  if (tokens.size >= 200) tokens.delete(tokens.keys().next().value!)
  tokens.set(token, sessionId)
  return { TOUSHOU_SESSION_TOPIC: `http://127.0.0.1:${port}/${token}` }
}

export function revokeSessionTopicBridge(sessionId: string): void {
  for (const [token, id] of tokens) if (id === sessionId) tokens.delete(token)
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const sessionId = tokens.get((request.url ?? '').slice(1))
  if (request.method !== 'POST' || !sessionId || !dependencies) return json(response, 403, { ok: false, error: 'forbidden' })
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > 2048) return json(response, 413, { ok: false, error: 'request-too-large' })
      chunks.push(buffer)
    }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { return json(response, 400, { ok: false, error: 'bad-json' }) }
    const parsed = parseSessionTopicRequest(raw)
    if (!parsed) return json(response, 400, { ok: false, error: 'invalid-topic' })
    return json(response, 200, await dispatchSessionTopic(dependencies, sessionId, parsed))
  } catch { return json(response, 200, { ok: false, error: 'topic-unavailable' }) }
}

function json(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

export async function resetSessionTopicBridgeForTest(): Promise<void> {
  tokens.clear()
  dependencies = undefined
  port = undefined
  ready = undefined
  const previous = server
  server = undefined
  if (previous) await new Promise<void>((resolve) => previous.close(() => resolve()))
}
