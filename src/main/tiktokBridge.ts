import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { serializeBoundedJson } from '../shared/boundedJson'
import { tiktokReportService } from './integrations/tiktok/TikTokRefreshService'

/**
 * Loopback bridge for the bundled TikTok toolkit: the OMP extension registers
 * touhou_tiktok_update/status and calls back into Main over this server.
 * Main owns the credentials and the dataset write — the tool process never
 * touches tokens or files, and the report always lands in the shared
 * "TikTok 报表" dataset the boards bind to.
 */

const MAX_BODY_BYTES = 16 * 1024
export const TIKTOK_TOOLS_ENV_KEY = 'TOUSHOU_TIKTOK'

export type TikTokBridgeRequest =
  | { action: 'tiktok_update'; days?: unknown; advertiserId?: unknown }
  | { action: 'tiktok_status' }

export function parseTikTokBridgeRequest(raw: unknown): TikTokBridgeRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.action === 'tiktok_status') return { action: 'tiktok_status' }
  if (value.action === 'tiktok_update') {
    return {
      action: 'tiktok_update',
      days: value.days,
      advertiserId: value.advertiserId
    }
  }
  return null
}

let port: number | null = null
let ready: Promise<void> | null = null
const tokens = new Map<string, string>()

export function initTiktokBridge(): Promise<void> {
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
      if (!address || typeof address === 'string') return fail(new Error('tiktok bridge did not receive a port'))
      port = address.port
      resolve()
    })
  })
  return ready
}

/** Per-session loopback URL injected into the OMP process env. */
export function tiktokBridgeEnv(sessionId: string): Record<string, string> {
  if (port === null) return {}
  const token = randomBytes(24).toString('hex')
  if (tokens.size >= 200) {
    const oldest = tokens.keys().next().value
    if (oldest !== undefined) tokens.delete(oldest)
  }
  tokens.set(token, sessionId)
  return { [TIKTOK_TOOLS_ENV_KEY]: `http://127.0.0.1:${port}/${token}` }
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
  const tool = parseTikTokBridgeRequest(raw)
  if (!tool) return json(response, 400, { ok: false, error: 'unsupported-action' })
  // Session binding: the tool only works inside a live TouShou session.
  const { getSession } = await import('./omp')
  if (!getSession(sessionId)) return json(response, 200, { ok: false, error: 'no-session' })
  return json(response, 200, await dispatch(tool))
}

async function dispatch(tool: TikTokBridgeRequest): Promise<Record<string, unknown>> {
  if (tool.action === 'tiktok_status') {
    return { ok: true, status: tiktokReportService.getStatus() }
  }
  // tiktok_update — days is advisory for the fixed 7-day report window v1;
  // advertiserId rides through when the store has multiple advertisers.
  const outcome = await tiktokReportService.refreshNow()
  if (!outcome.ok) {
    return { ok: false, error: outcome.error ?? 'refresh-failed', dataset: 'TikTok 报表' }
  }
  return {
    ok: true,
    dataset: 'TikTok 报表',
    rowCount: outcome.rowCount,
    truncated: outcome.truncated,
    refreshedAt: Date.now()
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(serializeBoundedJson(body, 30_000))
}

/** Test-only: drop tokens so module state cannot leak between cases. */
export function resetTiktokBridgeForTest(): void {
  tokens.clear()
}
