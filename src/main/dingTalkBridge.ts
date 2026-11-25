import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { serializeBoundedJson } from '../shared/boundedJson'
import { isDingTalkNodeId, isDingTalkWrite, parseDingTalkRequest } from './integrations/dingtalk/requests'
import type { DingTalkToolError, DingTalkToolResult, DingTalkWriteRequest } from '../shared/connections'

export { parseDingTalkRequest }

// The largest accepted Markdown body can be encoded as JSON unicode escapes.
const MAX_BODY_BYTES = 400_000
const MAX_RESULT_BYTES = 48_000
const QUERY_TIMEOUT_MS = 25_000
const WRITE_TIMEOUT_MS = 180_000
const MAX_LIVE_CAPABILITIES = 200
export const DINGTALK_TOOLS_ENV_KEY = 'TOUSHOU_DINGTALK'

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
  let fallback: DingTalkToolError = 'read-failed'
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
    const tool = parseDingTalkRequest(payload)
    if (!tool) return send(response, 400, { ok: false, error: 'invalid-input' })

    const write = isDingTalkWrite(tool)
    const signal = AbortSignal.any([capability.lifetime.signal, closed.signal, AbortSignal.timeout(write ? WRITE_TIMEOUT_MS : QUERY_TIMEOUT_MS)])
    const { getSession, getSessionBridgeAccess } = await import('./omp')
    const liveAccess = () => {
      const access = getSessionBridgeAccess(capability.sessionId)
      const session = getSession(capability.sessionId)
      return access && session && !access.remoteReadonly && !session.origin ? access : null
    }
    const initial = liveAccess()
    if (!initial || signal.aborted) return send(response, 403, { ok: false, error: 'forbidden' })

    const { dingTalkConnectionManager: manager } = await import('./integrations/dingtalk/DingTalkConnectionManager')
    const sameWorkspace = () => !capability.lifetime.signal.aborted && liveAccess()?.cwd === initial.cwd
    if (!sameWorkspace()) return send(response, 403, { ok: false, error: 'forbidden' })
    let result: DingTalkToolResult
    if (write) {
      fallback = 'write-failed'
      if (!['full', 'no-bash', 'ask'].includes(initial.mode)) return send(response, 403, { ok: false, error: 'write-forbidden' })
      await manager.initialize()
      const binding = manager.connectedLifetime()
      if (!binding) return send(response, 200, { ok: false, error: 'not-connected' })
      const writeSignal = AbortSignal.any([binding, signal])
      const canWrite = () => {
        const current = liveAccess()
        return !writeSignal.aborted && current?.cwd === initial.cwd && current.mode === initial.mode
      }
      if (!canWrite()) return send(response, 403, { ok: false, error: 'write-forbidden' })
      if (initial.mode === 'ask' && (!await confirmWrite(tool, writeSignal) || !canWrite())) {
        return send(response, 403, { ok: false, error: 'write-forbidden' })
      }
      fallback = 'write-outcome-unknown'
      result = await manager.execute(tool, writeSignal, canWrite)
    } else {
      result = await manager.execute(tool, signal)
    }
    if (!sameWorkspace()) return send(response, 403, { ok: false, error: write ? 'write-outcome-unknown' : 'forbidden' })
    if (signal.aborted) return send(response, 200, { ok: false, error: fallback })
    return send(response, 200, projectResult(result, fallback))
  } catch {
    return send(response, 200, { ok: false, error: fallback })
  }
}

async function confirmWrite(tool: DingTalkWriteRequest, signal: AbortSignal): Promise<boolean> {
  try {
    const { BrowserWindow, dialog } = await import('electron')
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
    if (!win || win.isDestroyed() || signal.aborted) return false
    const creating = tool.action === 'create_document'
    const target = creating ? tool.title + '（' + (tool.folderId ?? '我的文档') + '）' : 'https://alidocs.dingtalk.com/i/nodes/' + tool.documentId
    const preview = tool.content?.slice(0, 500) ?? ''
    const detail = [target, preview + ((tool.content?.length ?? 0) > preview.length ? '…' : '')].filter(Boolean).join('\n\n')
    const result = await dialog.showMessageBox(win, {
      type: 'question', title: '钉钉文档', message: creating ? '允许新建这篇钉钉文档？' : '允许向这篇钉钉文档追加正文？',
      detail, buttons: ['取消', '允许一次'], defaultId: 0, cancelId: 0, noLink: true, signal
    })
    return result.response === 1 && !signal.aborted
  } catch {
    return false
  }
}

const TOOL_ERRORS = new Set<DingTalkToolError>([
  'not-connected', 'invalid-input', 'cli-unavailable', 'organization-access-required', 'not-authorized', 'permission-denied', 'network', 'read-failed',
  'write-failed', 'write-forbidden', 'write-outcome-unknown'
])

function projectResult(result: DingTalkToolResult, fallback: DingTalkToolError): Record<string, unknown> {
  if (result.ok) return { ok: true, source: 'DingTalk', data: result.data }
  const error = TOOL_ERRORS.has(result.error) ? result.error : fallback
  const nodeId = error === 'write-outcome-unknown' && isDingTalkNodeId(result.nodeId) ? result.nodeId : undefined
  return { ok: false, error, ...(nodeId ? { nodeId } : {}) }
}

function send(response: ServerResponse, status: number, result: Record<string, unknown>): void {
  if (response.destroyed) return
  const body = serializeBoundedJson(result, MAX_RESULT_BYTES)
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(body)
}
