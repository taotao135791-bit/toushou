import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { serializeBoundedJson } from '../shared/boundedJson'
import { resolveEnvProxyRules } from './integrations/tiktok/envProxy'
import { AdsCopyModelStore, type AdsCopyModelPool, type AdsCopyModelProvider } from './integrations/adscopy/AdsCopyModelStore'
import { callCopyModel, pickStablePoolMember, type CopyFetch } from './integrations/adscopy/copyGenerate'

/**
 * Loopback bridge for the ads-copy toolkit: the OMP extension registers
 * toushou_copy_* tools and calls back into Main. Model API keys live only in
 * the encrypted AdsCopyModelStore and only Main dials the providers — the
 * agent process never sees a key. This pool belongs to the copy tool alone;
 * the chat session's own model routing is never touched.
 */
const MAX_BODY_BYTES = 64 * 1024
export const COPY_TOOLS_ENV_KEY = 'TOUSHOU_COPY'
const MAX_PROMPT_CHARS = 24_000

export type AdsCopyBridgeRequest =
  | { action: 'copy_models_list' }
  | { action: 'copy_generate'; prompt?: unknown; system?: unknown; model?: unknown; agentId?: unknown }

export function parseAdsCopyBridgeRequest(raw: unknown): AdsCopyBridgeRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.action === 'copy_models_list') return { action: 'copy_models_list' }
  if (value.action === 'copy_generate') {
    return {
      action: 'copy_generate',
      prompt: value.prompt,
      system: value.system,
      model: value.model,
      agentId: value.agentId
    }
  }
  return null
}

let port: number | null = null
let ready: Promise<void> | null = null
const tokens = new Map<string, string>()

const store = new AdsCopyModelStore()
/** Shared instance the Connections-page IPC uses (single encrypted file). */
export const adsCopyModelStore = store

export function initAdsCopyBridge(): Promise<void> {
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
      if (!address || typeof address === 'string') return fail(new Error('ads-copy bridge did not receive a port'))
      port = address.port
      resolve()
    })
  })
  return ready
}

export function adsCopyBridgeEnv(sessionId: string): Record<string, string> {
  if (port === null) return {}
  const token = randomBytes(24).toString('hex')
  if (tokens.size >= 200) {
    const oldest = tokens.keys().next().value
    if (oldest !== undefined) tokens.delete(oldest)
  }
  tokens.set(token, sessionId)
  return { [COPY_TOOLS_ENV_KEY]: `http://127.0.0.1:${port}/${token}` }
}

/**
 * Proxy-aware fetch for user-configured model endpoints — same policy as the
 * TikTok connection: explicit env proxy wins, otherwise the OS proxy settings;
 * never a forced direct connection (many providers need a proxy from CN).
 */
let sessionFetchCache: { rules: string | null; promise: Promise<{ fetch: CopyFetch }> } | null = null
async function proxySessionFetch(): Promise<CopyFetch> {
  const rules = resolveEnvProxyRules('https://model.invalid/')
  if (!sessionFetchCache || sessionFetchCache.rules !== rules) {
    sessionFetchCache = { rules, promise: (async () => {
      const { session } = await import('electron')
      const ses = session.fromPartition('ads-copy-models')
      await ses.setProxy(rules ? { proxyRules: rules } : { mode: 'system' })
      return { fetch: (url, init) => ses.fetch(url, init) as unknown as ReturnType<CopyFetch> }
    })() }
  }
  return sessionFetchCache.promise.then(({ fetch }) => fetch)
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
  const tool = parseAdsCopyBridgeRequest(raw)
  if (!tool) return json(response, 400, { ok: false, error: 'unsupported-action' })
  const { getSession } = await import('./omp')
  if (!getSession(sessionId)) return json(response, 200, { ok: false, error: 'no-session' })
  return json(response, 200, await dispatch(tool, { fetchImpl: await proxySessionFetch() }))
}

export interface AdsCopyDispatchDeps {
  fetchImpl: CopyFetch
  pool?: AdsCopyModelPool
  now?: () => number
}

async function loadPool(deps: AdsCopyDispatchDeps): Promise<AdsCopyModelPool> {
  return deps.pool ?? store.load()
}

export async function dispatch(tool: AdsCopyBridgeRequest, deps: AdsCopyDispatchDeps): Promise<Record<string, unknown>> {
  if (tool.action === 'copy_models_list') {
    const pool = await loadPool(deps)
    const members = pool.pool
      .map((id) => pool.providers.find((provider) => provider.id === id))
      .filter((provider): provider is AdsCopyModelProvider => provider !== undefined)
    return {
      ok: true,
      providers: pool.providers.map((provider) => ({ name: provider.name, model: provider.model, protocol: provider.protocol })),
      pool: members.map((provider) => provider.name),
      hint:
        members.length > 0
          ? '生成时可用 model 指定供应商名；传 agentId（如产品名）会稳定分配池内一个模型；两者都不传则全池并发生成。'
          : '模型池为空：请在投手「连接」页的文案模型池里添加模型。'
    }
  }

  // copy_generate
  const prompt = typeof tool.prompt === 'string' ? tool.prompt.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: 'invalid-prompt' }
  const system = typeof tool.system === 'string' && tool.system.trim() ? tool.system.trim().slice(0, 8_000) : undefined
  const pool = await loadPool(deps)
  const modelName = typeof tool.model === 'string' ? tool.model.trim() : ''
  const agentId = typeof tool.agentId === 'string' ? tool.agentId.trim().slice(0, 120) : ''

  let targets: AdsCopyModelProvider[]
  if (modelName) {
    const named = pool.providers.find((provider) => provider.name.toLowerCase() === modelName.toLowerCase())
    if (!named) {
      return { ok: false, error: 'model-not-found', available: pool.providers.map((provider) => provider.name) }
    }
    targets = [named]
  } else {
    const members = pool.pool
      .map((id) => pool.providers.find((provider) => provider.id === id))
      .filter((provider): provider is AdsCopyModelProvider => provider !== undefined)
    if (members.length === 0) {
      return {
        ok: false,
        error: 'pool-empty',
        hint: '模型池为空：请在投手「连接」页的文案模型池里添加模型，或用当前对话模型直接生成。'
      }
    }
    // Stable per-agent assignment keeps one product on one model (the user's
    // original pool semantics); without an agent key, fan out to the pool.
    targets = agentId ? [pickStablePoolMember(members, agentId)!] : members
  }

  const settled = await Promise.all(
    targets.map(async (provider) => {
      const result = await callCopyModel(deps.fetchImpl, provider, { system, prompt })
      return {
        model: provider.model,
        name: provider.name,
        ...(result.ok && result.text ? { text: result.text.slice(0, 20_000) } : { error: result.ok ? 'empty-response' : result.error })
      }
    })
  )
  const anyOk = settled.some((result) => 'text' in result)
  return { ok: anyOk, results: settled }
}

/** Connections-page "test" button: one tiny completion against a stored provider. */
export async function testAdsCopyProviderById(id: string): Promise<{ ok: boolean; error?: string }> {
  const pool = await store.load()
  const provider = pool.providers.find((item) => item.id === id)
  if (!provider) return { ok: false, error: 'not-found' }
  const fetchImpl = await proxySessionFetch()
  const result = await callCopyModel(fetchImpl, provider, {
    system: 'You are a connectivity probe. Reply with exactly: OK',
    prompt: 'ping',
    maxTokens: 16
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(serializeBoundedJson(body, 60_000))
}
