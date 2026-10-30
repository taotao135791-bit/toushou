import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { serializeBoundedJson } from '../shared/boundedJson'
import { proxyFetchFor as proxyAwareFetch } from './integrations/tiktok/proxyFetch'
import { AdsCopyModelStore, type AdsCopyModelPool, type AdsCopyModelProvider } from './integrations/adscopy/AdsCopyModelStore'
import { callCopyModel, discoverModels, pickStablePoolMember, type CopyFetch } from './integrations/adscopy/copyGenerate'
import {
  computeShortfall,
  creativeFrameworkBrief,
  normalizeModelOutput,
  providerRotationIndex,
  resolveTargets,
  scoreCopyItem,
  selectTopN,
  targetedFixLines,
  type CopyCategoryRequest,
  type ScoredCopyItem
} from './integrations/adscopy/copyEngine'
import { validateAdsCopyModelInput } from './integrations/adscopy/AdsCopyModelStore'

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
  | { action: 'copy_generate_batch'; request?: unknown }

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
  if (value.action === 'copy_generate_batch') return { action: 'copy_generate_batch', request: value }
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

/** Free every token minted for a session — wired to the 'closed' event so a
 *  long-lived app never evicts a STILL-RUNNING session's tools at the cap. */
export function revokeAdsCopyBridgeTokens(sessionId: string): void {
  for (const [token, owner] of tokens) {
    if (owner === sessionId) tokens.delete(token)
  }
}

/**
 * Proxy-aware fetch for user-configured model endpoints. Each call resolves
 * the proxy for ITS OWN URL, so a NO_PROXY entry for a relay host (or for
 * TikTok) is honoured independently — model traffic never inherits TikTok's
 * verdict, and vice versa.
 */
async function proxySessionFetch(): Promise<CopyFetch> {
  return async (url, init) => {
    const fetch = await proxyAwareFetch(url, 'ads-copy-models')
    return fetch(url, init as RequestInit) as unknown as ReturnType<CopyFetch>
  }
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
  try {
    return json(response, 200, await dispatch(tool, { fetchImpl: await proxySessionFetch() }))
  } catch {
    // An unreadable model store (or any dispatch failure) must surface as a
    // clean error — never kill the connection mid-call.
    return json(response, 200, { ok: false, error: 'store-unreadable' })
  }
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
  // ONE decrypt per request: the pool file is read/decrypted once and the
  // promise threads through every branch (read→decrypt is not free, and the
  // batch fan-out used to trigger it three times per call).
  const poolOnce = loadPool(deps)
  if (tool.action === 'copy_models_list') {
    const pool = await poolOnce
    const members = pool.pool
      .map((id) => pool.providers.find((provider) => provider.id === id))
      .filter((provider): provider is AdsCopyModelProvider => provider !== undefined)
    return {
      ok: true,
      mode: pool.mode,
      providers: pool.providers.map((provider) => ({ name: provider.name, model: provider.model, protocol: provider.protocol })),
      pool: members.map((provider) => provider.name),
      hint:
        pool.mode === 'chat'
          ? '当前模式：跟随对话模型（copy_generate 不可用）。用户在「连接 → 文案模型池」切换为自定义模型池后，本工具才开始工作。'
          : members.length > 0
            ? '生成时可用 model 指定供应商名；传 agentId（如产品名）会稳定分配池内一个模型；两者都不传则全池并发生成。'
            : '模型池为空：请在投手「连接」页的文案模型池里添加模型。'
    }
  }

  // The user may switch the copy tool back to "follow the chat model" at any
  // time — the agent then generates directly and never calls this bridge.
  if ((await poolOnce).mode === 'chat') {
    return {
      ok: false,
      error: 'mode-is-chat',
      hint: '当前文案模式为「跟随对话模型」：请不要调用本工具，直接按 ads-copy 技能用当前对话模型生成并交付。'
    }
  }

  // copy_generate
  if (tool.action === 'copy_generate') {
    const prompt = typeof tool.prompt === 'string' ? tool.prompt.trim() : ''
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: 'invalid-prompt' }
    const system = typeof tool.system === 'string' && tool.system.trim() ? tool.system.trim().slice(0, 8_000) : undefined
    const pool = await poolOnce
    const modelName = typeof tool.model === 'string' ? tool.model.trim() : ''
    const agentId = typeof tool.agentId === 'string' ? tool.agentId.trim().slice(0, 120) : ''

    let targets: AdsCopyModelProvider[]
    let strategy = 'parallel'
    if (modelName) {
      const named = pool.providers.find((provider) => provider.name.toLowerCase() === modelName.toLowerCase())
      if (!named) {
        return { ok: false, error: 'model-not-found', available: pool.providers.map((provider) => provider.name) }
      }
      targets = [named]
      strategy = 'named'
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
      if (agentId) {
        targets = [pickStablePoolMember(members, agentId)!]
        strategy = 'agent_sticky'
      } else {
        targets = members
      }
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
    return { ok: anyOk, strategy, results: settled }
  }

  return dispatchBatch(tool.request as Record<string, unknown>, deps, await poolOnce)
}

// ---------------------------------------------------------------------------
// copy_generate_batch — the factory worker's score-control loop, faithfully:
// multi-attempt, shortfall-driven provider rotation, candidate oversampling,
// deterministic 5-dim scoring, top-N selection with dedupe, targeted fixes.
// ---------------------------------------------------------------------------

const SHORT_MAX_BYTES = 25
const LONG_MAX_BYTES = 75

function boundedStringArray(value: unknown, max: number, perItem: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, perItem))
    .slice(0, max)
}

function buildBatchPrompt(opts: {
  language: string
  market?: string
  device?: string
  benefits: string[]
  tone?: string
  brandTerms: string[]
  qtyShort: number
  qtyLong: number
  attempt: number
  frameworkBrief: string
  fixLines: string[]
}): string {
  const lines = [
    `你是资深谷歌 App Campaign 广告优化师。用${opts.language}生成广告素材，只输出 JSON：{"short":[...],"long":[...]}，无其他文字。`,
    opts.market ? `投放市场：${opts.market}。` : '',
    opts.device ? `投放设备：${opts.device}。` : '',
    `语言纯正（${opts.language}），禁止机翻腔、禁止感叹号、每条必须互不重复。`,
    `事实边界——卖点只允许围绕以下内容（不得编造任何资质/收益/保证）：${opts.benefits.join('；')}`,
    opts.brandTerms.length > 0 ? `品牌词（可自然融入）：${opts.brandTerms.join('、')}` : '',
    opts.tone ? `语气基调：${opts.tone}。` : '',
    `数量：short（短标题）恰好 ${opts.qtyShort} 条，每条 ≤ ${SHORT_MAX_BYTES} 字节（中日韩字符每个算 2 字节，ASCII 算 1 字节）；long（长描述）恰好 ${opts.qtyLong} 条，每条 ≤ ${LONG_MAX_BYTES} 字节。`,
    '短标题利益点优先；长描述=具体日常利益+自然行动号召（目标语言的动词）。',
    opts.attempt > 1 ? `创作框架（本轮采用）：${opts.frameworkBrief}` : '',
    opts.fixLines.length > 0 ? `针对性修复要求：\n- ${opts.fixLines.join('\n- ')}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * Map a scoring rejectReason onto the retry-fix vocabulary (copyEngine's
 * FIX_ACTIONS keys). Without this the retry prompt silently lost every
 * targeted fix line because the two vocabularies never matched.
 */
function noteFailure(counts: Record<string, number>, item: ScoredCopyItem): void {
  const reason = item.rejectReason ?? 'other'
  const key =
    reason === 'over_limit'
      ? 'over'
      : reason === 'financial_compliance_violation'
        ? 'compliance'
        : reason === 'below_score_targets'
          ? 'total'
          : reason
  counts[key] = (counts[key] ?? 0) + 1
}

async function dispatchBatch(
  raw: Record<string, unknown>,
  deps: AdsCopyDispatchDeps,
  pool: AdsCopyModelPool
): Promise<Record<string, unknown>> {
  if (pool.mode === 'chat') {
    return {
      ok: false,
      error: 'mode-is-chat',
      hint: '当前文案模式为「跟随对话模型」：不要调用本工具，直接按 ads-copy 技能用当前对话模型生成并交付。'
    }
  }
  const members = pool.pool
    .map((id) => pool.providers.find((provider) => provider.id === id))
    .filter((provider): provider is AdsCopyModelProvider => provider !== undefined)
  if (members.length === 0) {
    return { ok: false, error: 'pool-empty', hint: '模型池为空：请在投手「连接」页的文案模型池里添加模型。' }
  }

  // Request parsing (bounded; anything malformed falls back or rejects).
  const product = (raw.product ?? {}) as Record<string, unknown>
  const language = typeof product.language === 'string' && product.language.trim() ? product.language.trim().slice(0, 20) : 'en'
  const market = typeof product.market === 'string' ? product.market.trim().slice(0, 40) : undefined
  const device = typeof product.device === 'string' ? product.device.trim().slice(0, 20) : undefined
  const tone = typeof product.tone === 'string' ? product.tone.trim().slice(0, 60) : undefined
  const benefits = boundedStringArray(product.benefits, 20, 120)
  const brandTerms = boundedStringArray(product.brandTerms, 10, 60)
  const categoriesRaw = Array.isArray(raw.categories) ? raw.categories : []
  const categories: CopyCategoryRequest[] = categoriesRaw
    .map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>
      const type = entry.type === 'long' ? 'long' : entry.type === 'short' ? 'short' : null
      const qty = Math.min(Math.max(Number(entry.qty) || 5, 1), 50)
      return type ? { type, qty } : null
    })
    .filter((item): item is CopyCategoryRequest => item !== null)
    .slice(0, 2)
  if (categories.length === 0) categories.push({ type: 'short', qty: 5 }, { type: 'long', qty: 5 })
  const wantShort = categories.filter((c) => c.type === 'short').reduce((m, c) => Math.max(m, c.qty), 0)
  const wantLong = categories.filter((c) => c.type === 'long').reduce((m, c) => Math.max(m, c.qty), 0)

  const targets = resolveTargets((raw.targets ?? {}) as Record<string, unknown>)
  const maxAttempts = Math.min(Math.max(Number(raw.maxAttempts) || 3, 1), 5)
  const multiplier = Math.min(Math.max(Number(raw.candidateMultiplier) || 3, 1), 4)
  const modelName = typeof raw.model === 'string' ? raw.model.trim() : ''
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim().slice(0, 120) : ''

  let fixed: AdsCopyModelProvider[] | null = null
  let strategy = 'parallel'
  let assignedIndex: number | undefined
  if (modelName) {
    const named = pool.providers.find((provider) => provider.name.toLowerCase() === modelName.toLowerCase())
    if (!named) return { ok: false, error: 'model-not-found', available: pool.providers.map((provider) => provider.name) }
    fixed = [named]
    strategy = 'named'
  } else if (agentId) {
    fixed = [pickStablePoolMember(members, agentId)!]
    strategy = 'agent_sticky'
    assignedIndex = members.indexOf(fixed[0])
  }

  const shortPool: ScoredCopyItem[] = []
  const longPool: ScoredCopyItem[] = []
  const providerErrors: Array<Record<string, unknown>> = []
  const retryHistory: Array<Record<string, unknown>> = []
  let acceptedShort = 0
  let acceptedLong = 0
  const failureCounts: Record<string, number> = {}

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const shortfall = computeShortfall(acceptedShort, acceptedLong, categories)
    if (shortfall <= 0) break
    const roundProviders = fixed ?? Array.from({ length: Math.min(members.length, shortfall) }, (_, i) =>
      members[providerRotationIndex(members.length, 0, attempt, i)]
    )
    const uniqueProviders = [...new Map(roundProviders.map((provider) => [provider.id, provider])).values()]
    const perCallQty = Math.min(Math.ceil(shortfall / uniqueProviders.length) * multiplier, 50)
    const fixLines = attempt > 1 ? targetedFixLines(failureCounts) : []
    const prompt = buildBatchPrompt({
      language,
      market,
      device,
      benefits,
      tone,
      brandTerms,
      qtyShort: wantShort > 0 ? perCallQty : 0,
      qtyLong: wantLong > 0 ? perCallQty : 0,
      attempt,
      frameworkBrief: creativeFrameworkBrief(attempt, 0),
      fixLines
    })
    const roundStart = { attempt, providers: uniqueProviders.map((provider) => provider.name), asked: perCallQty }
    const settled = await Promise.all(
      uniqueProviders.map(async (provider) => {
        const result = await callCopyModel(deps.fetchImpl, provider, {
          system: '你是广告文案生成器，只输出 JSON，不输出解释。',
          prompt,
          temperature: 0.95
        })
        return { provider, result }
      })
    )
    let roundShort = 0
    let roundLong = 0
    for (const { provider, result } of settled) {
      if (!result.ok || !result.text) {
        providerErrors.push({ name: provider.name, model: provider.model, attempt, error: result.error ?? 'empty-response' })
        continue
      }
      const normalized = normalizeModelOutput(result.text, { short: SHORT_MAX_BYTES, long: LONG_MAX_BYTES })
      for (const text of normalized.shorts) {
        const item = scoreCopyItem(text, { type: 'short', maxBytes: SHORT_MAX_BYTES, language, benefits, brandTerms, targets })
        shortPool.push(item)
        if (item.accepted) roundShort++
        else noteFailure(failureCounts, item)
      }
      for (const text of normalized.longs) {
        const item = scoreCopyItem(text, { type: 'long', maxBytes: LONG_MAX_BYTES, language, benefits, brandTerms, targets })
        longPool.push(item)
        if (item.accepted) roundLong++
        else noteFailure(failureCounts, item)
      }
    }
    acceptedShort += roundShort
    acceptedLong += roundLong
    retryHistory.push({ ...roundStart, acceptedShort: roundShort, acceptedLong: roundLong })
  }

  const shortSelection = wantShort > 0 ? selectTopN(shortPool, 'short', wantShort) : { selected: [], rejected: [] }
  const longSelection = wantLong > 0 ? selectTopN(longPool, 'long', wantLong) : { selected: [], rejected: [] }
  const anyOk = shortSelection.selected.length > 0 || longSelection.selected.length > 0
  return {
    ok: anyOk,
    results: {
      ...(wantShort > 0
        ? {
            short: {
              items: shortSelection.selected,
              fulfilled: shortSelection.selected.length >= wantShort,
              want: wantShort
            }
          }
        : {}),
      ...(wantLong > 0
        ? {
            long: {
              items: longSelection.selected,
              fulfilled: longSelection.selected.length >= wantLong,
              want: wantLong
            }
          }
        : {})
    },
    score_control: {
      targets,
      attempts: retryHistory.length,
      maxAttempts,
      candidateMultiplier: multiplier,
      acceptedShort,
      acceptedLong,
      rejectedShort: shortSelection.rejected.length,
      rejectedLong: longSelection.rejected.length
    },
    provider_pool: { size: members.length, strategy, agentId: agentId || undefined, assignedIndex },
    provider_errors: providerErrors,
    retry_history: retryHistory
  }
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

/** Connections-page model sniffing: list what a relay station actually offers. */
export async function discoverAdsCopyModels(input: {
  baseUrl?: unknown
  protocol?: unknown
  apiKey?: unknown
}): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const checked = validateAdsCopyModelInput({ name: 'x', baseUrl: input.baseUrl, protocol: input.protocol, model: 'x', apiKey: input.apiKey })
  if ('error' in checked) return { ok: false, error: checked.error }
  const fetchImpl = await proxySessionFetch()
  return discoverModels(fetchImpl, { baseUrl: checked.baseUrl, protocol: checked.protocol, apiKey: checked.apiKey })
}

export async function setAdsCopyMode(mode: 'chat' | 'pool'): Promise<void> {
  await store.setMode(mode)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(serializeBoundedJson(body, 60_000))
}
