import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { BrowserWindow, dialog } from 'electron'
import { serializeBoundedJson } from '../shared/boundedJson'
import type { PermissionMode } from '../shared/types'
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
  try {
    return json(response, 200, await authorizeTikTokRequest(sessionId, tool))
  } catch {
    return json(response, 200, { ok: false, error: 'refresh-failed' })
  }
}

type SessionAccess = { cwd: string; mode: PermissionMode; remoteReadonly: boolean }
type BridgeDeps = {
  getAccess: (id: string) => SessionAccess | null
  confirm: () => Promise<boolean>
  refresh: typeof tiktokReportService.refreshNow
  status: typeof tiktokReportService.getStatus
}

/** Enforce session authority in Main, including just before the dataset write. */
export async function authorizeTikTokRequest(sessionId: string, tool: TikTokBridgeRequest, deps?: BridgeDeps): Promise<Record<string, unknown>> {
  const getAccess = deps?.getAccess ?? (await import('./omp')).getSessionBridgeAccess
  const access = getAccess(sessionId)
  if (!access) return { ok: false, error: 'no-session' }
  if (tool.action === 'tiktok_status') {
    return { ok: true, status: (deps?.status ?? (() => tiktokReportService.getStatus()))() }
  }
  if (tool.days !== undefined && tool.days !== 7) return { ok: false, error: 'unsupported-range', hint: '仅支持近 7 天。' }
  if (tool.advertiserId !== undefined && (typeof tool.advertiserId !== 'string' || !/^\d{1,30}$/.test(tool.advertiserId))) return { ok: false, error: 'invalid-advertiser-id', hint: '广告主 ID 必须为数字字符串。' }
  if (access.remoteReadonly || !['full', 'no-bash', 'ask'].includes(access.mode)) return { ok: false, error: 'permission-denied' }
  if (access.mode === 'ask') {
    const confirm = deps?.confirm ?? (async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
      if (!win || win.isDestroyed()) return false
      const answer = await dialog.showMessageBox(win, {
        type: 'question', title: '确认更新 TikTok 看板',
        message: '允许此会话读取 TikTok 报表并更新本地数据集？',
        detail: tool.advertiserId ? `广告主 ID：${tool.advertiserId}` : '范围：已配置的广告主；未选择时读取授权广告主。',
        buttons: ['拒绝', '允许一次'], defaultId: 0, cancelId: 0, noLink: true
      })
      return answer.response === 1
    })
    if (!(await confirm())) return { ok: false, error: 'permission-denied' }
  }
  const beforeWrite = (): boolean => {
    const current = getAccess(sessionId)
    return Boolean(current && !current.remoteReadonly && ['full', 'no-bash', 'ask'].includes(current.mode) && current.cwd === access.cwd && (current.mode !== 'ask' || access.mode === 'ask'))
  }
  if (!beforeWrite()) return { ok: false, error: 'permission-denied' }
  const refresh = deps?.refresh ?? ((options) => tiktokReportService.refreshNow(options))
  const outcome = await refresh({ ...(tool.advertiserId ? { advertiserId: tool.advertiserId as string } : {}), beforeWrite })
  if (!outcome.ok) {
    return { ok: false, error: outcome.error ?? 'refresh-failed', dataset: 'TikTok 报表' }
  }
  return {
    ok: true,
    dataset: 'TikTok 报表',
    rowCount: outcome.rowCount,
    truncated: outcome.truncated,
    ...(outcome.legacyBackups?.length ? { legacyBackups: outcome.legacyBackups } : {}),
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
