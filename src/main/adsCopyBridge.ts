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
  scoringLexiconBrief,
  selectTopN,
  targetedFixLines,
  type CopyCategoryRequest,
  type CopyScoreTargets,
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
/**
 * Per-call budget. Thinking-heavy models can need 60s+ on a big candidate
 * batch; a call that exceeds this is cancelled and reported as `timeout`
 * instead of holding the round (and the user) hostage.
 */
const COPY_CALL_TIMEOUT_MS = 75_000

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
  targets: Required<CopyScoreTargets>
  direction: string
  rejectedSamples: string[]
}): string {
  const lexicon = scoringLexiconBrief(opts.language)
  const quantities = [
    opts.qtyShort > 0 ? `short（短标题）恰好 ${opts.qtyShort} 条，每条 19–25 字节（上限 ${SHORT_MAX_BYTES}）` : '',
    opts.qtyLong > 0 ? `long（长描述）恰好 ${opts.qtyLong} 条，每条 56–75 字节（上限 ${LONG_MAX_BYTES}）` : ''
  ].filter(Boolean).join('；')
  const lines = [
    `你是资深谷歌 App Campaign 广告优化师。用${opts.language}生成广告素材，只输出 JSON：{"short":[...],"long":[...]}，无其他文字。`,
    opts.market ? `投放市场：${opts.market}。` : '',
    opts.device ? `投放设备：${opts.device}。` : '',
    `语言纯正（${opts.language}），禁止机翻腔、禁止感叹号、每条必须互不重复。`,
    `事实边界——卖点只允许围绕以下内容（不得编造任何资质/收益/保证）：${opts.benefits.join('；')}`,
    opts.brandTerms.length > 0 ? `品牌词（可自然融入）：${opts.brandTerms.join('、')}` : '',
    opts.tone ? `语气基调：${opts.tone}。` : '',
    `数量：${quantities}。字节算法：CJK 字符算 2 字节，ASCII 算 1 字节。`,
    '每条文案都会按下面的确定性评分卡打分，达不到达标线直接淘汰——动笔前先对着评分卡写：',
    `- 钩子 Hook ≥${opts.targets.hook} 分：开头 1/3 必须出现钩子词之一（${lexicon.hook.join('、')}）；前半句带数字 +2 分、带问号 +2 分（数字必须来自已提供的事实）。`,
    `- 相关性 Relevance ≥${opts.targets.relevance} 分：必须覆盖至少 2 个卖点（原词或拆词）；覆盖 4 个以上满分。`,
    `- 行动号召 CTA ≥${opts.targets.cta} 分：必须包含动作动词之一（${lexicon.cta.join('、')}）。`,
    `- 空间 Space ≥${opts.targets.space} 分：短标题 19–25 字节、长描述 56–75 字节，接近上限优于留白；超上限直接淘汰。`,
    `- 品牌与合规：品牌词自然出现一次；绝对禁止出现：${lexicon.forbidden.join('、')}；也不得出现资质、收益、保证类表述。`,
    `- 总分 ≥ ${opts.targets.total} 分。`,
    `本轮方向：${opts.direction}${opts.attempt > 1 ? `（第 ${opts.attempt} 轮，上一轮未达标，必须换角度而不是在同一方向上微调；创作框架：${opts.frameworkBrief}）` : ''}`,
    opts.fixLines.length > 0 ? `针对性修复要求：\n- ${opts.fixLines.join('\n- ')}` : '',
    opts.rejectedSamples.length > 0 ? `以下文案在上一轮已被淘汰，不要生成相同或近似的：\n- ${opts.rejectedSamples.join('\n- ')}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

/** Rotating creative angles — a retry must change direction, not just reword. */
const CREATIVE_DIRECTIONS = [
  '直接利益：第一句就给出用户能立刻得到的结果',
  '场景切入：从用户具体的日常场景或痛点写起，再落到卖点',
  '提问开场：用目标语言的疑问句把钩子放到最前面',
  '差异化：聚焦本产品明确做到、而同类产品通常做不到的卖点',
  '行动结果：写清楚点击或使用之后立刻发生什么',
  '事实具体化：用已有事实里的细节让利益可感知（不新增数字或承诺）'
]

function directionBrief(attempt: number): string {
  return CREATIVE_DIRECTIONS[(Math.max(attempt, 1) - 1) % CREATIVE_DIRECTIONS.length]
}

/**
 * Count WHY a candidate was rejected. Below-target copy used to collapse into a
 * single 'total' bucket, so retries only ever got the generic "raise every
 * score" fix line; splitting by dimension lets the next round fix the actual
 * failing one (hook word missing, no CTA verb, byte band off…).
 */
function noteFailure(
  counts: Record<string, number>,
  item: ScoredCopyItem,
  targets: Required<CopyScoreTargets>
): void {
  if (item.rejectReason === 'over_limit') {
    counts.over = (counts.over ?? 0) + 1
    return
  }
  if (item.rejectReason === 'financial_compliance_violation') {
    counts.compliance = (counts.compliance ?? 0) + 1
    return
  }
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  if (item.rejectReason === 'below_score_targets') {
    let noted = false
    if (item.scores.hook < targets.hook) { bump('hook'); noted = true }
    if (item.scores.relevance < targets.relevance) { bump('rel'); noted = true }
    if (item.scores.cta < targets.cta) { bump('cta'); noted = true }
    if (item.scores.space < targets.space) { bump('space'); noted = true }
    if (!noted || item.scores.total < targets.total) bump('total')
    return
  }
  bump(item.rejectReason ?? 'other')
}

/** Most frequent rejection dimension — drives the next-step advice. */
function dominantFailure(counts: Record<string, number>): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const [key, value] of Object.entries(counts)) {
    if (value > bestCount) { best = key; bestCount = value }
  }
  return best
}

/**
 * What the caller should do instead of generating copy with the chat model:
 * change the prompt direction / product facts, or report honestly.
 */
function nextStepsFor(dominant: string | null): string[] {
  const rule = '不要用对话模型撰写、改写或补写文案；要继续就按下面的方向调整后再次调用本工具，否则如实向用户报告缺口。'
  switch (dominant) {
    case 'over':
      return ['压缩字节：短标题写到 19–25 字节、长描述 56–75 字节，先删虚词和修饰语', rule]
    case 'compliance':
      return ['去掉保证、无风险、第一、最安全一类绝对化表述，只写已提供的事实', rule]
    case 'hook':
      return ['把钩子词放进开头 1/3，并尽量在前半句带上事实里的数字或问句', rule]
    case 'cta':
      return ['补一个目标语言的动作动词，放在结尾的自然位置', rule]
    case 'rel':
      return ['让每条文案覆盖 2 个以上卖点（原词或拆词）；必要时把 benefits 写得更具体', rule]
    case 'space':
      return ['写满字节区间：短标题 19–25 字节、长描述 56–75 字节', rule]
    case 'total':
      return ['四项同时满足：钩子词 + 至少 2 个卖点 + 动作动词 + 字节写满', rule]
    default:
      return ['本轮没有拿到可用候选：先检查模型池的连通性与模型名，必要时调大 candidateMultiplier 后重试', rule]
  }
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
  /** Per-call latency, so "why was it slow" can be answered from the result. */
  const timings: Array<Record<string, unknown>> = []
  const retryHistory: Array<Record<string, unknown>> = []
  const startedAt = Date.now()
  /** Rejected lines of recent rounds, fed back as "do not resemble these". */
  const rejectedSamples: string[] = []
  let acceptedShort = 0
  let acceptedLong = 0
  let zeroStreak = 0
  let stagnated = false
  /** Consecutive failures per provider: two strikes and we stop asking it. */
  const failedCounts = new Map<string, number>()
  let stickyFallback = false
  const failureCounts: Record<string, number> = {}
  /**
   * Accepted lines are counted by unique text — a model repeating the same
   * line must not look like a covered quota (selection de-dupes later, so the
   * count and the delivered list would otherwise disagree).
   */
  const acceptedKeys = new Set<string>()
  const acceptUnique = (type: 'short' | 'long', text: string): boolean => {
    const key = `${type}::${text.trim().toLowerCase()}`
    if (acceptedKeys.has(key)) return false
    acceptedKeys.add(key)
    return true
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // computeShortfall floors at 1 by design (the factory worker always asks
    // for at least one more candidate), so fulfilment is checked explicitly —
    // otherwise every batch would burn all maxAttempts rounds even after the
    // quota was met.
    const fulfilledShort = wantShort === 0 || acceptedShort >= wantShort
    const fulfilledLong = wantLong === 0 || acceptedLong >= wantLong
    if (fulfilledShort && fulfilledLong) break
    const shortfall = computeShortfall(acceptedShort, acceptedLong, categories)
    // A pinned provider that keeps failing must not sink the whole job — drop
    // it back into the pool rotation instead of repeating the same dead call
    // until every attempt is spent. An explicit `model=` request is different:
    // the caller asked for THAT model, so we never silently deliver another
    // one; it either succeeds or the run reports the failure.
    const isNamed = strategy === 'named'
    const healthy = members.filter((member) => (failedCounts.get(member.id) ?? 0) < 2)
    const usable = healthy.length > 0 ? healthy : members
    const sticky = fixed && (isNamed || (failedCounts.get(fixed[0].id) ?? 0) === 0) ? fixed : null
    if (fixed && !sticky) stickyFallback = true
    // Try other usable members before retrying the failed sticky assignment.
    // Explicitly named models stay pinned and never enter this fallback.
    const alternatives = fixed && !sticky ? usable.filter(member => member.id !== fixed[0].id) : usable
    const rotating = alternatives.length > 0 ? alternatives : usable
    const roundProviders = sticky ?? Array.from({ length: Math.min(rotating.length, shortfall) }, (_, i) =>
      rotating[providerRotationIndex(rotating.length, 0, attempt, i)]
    )
    const uniqueProviders = [...new Map(roundProviders.map((provider) => [provider.id, provider])).values()]
    // Oversample just enough to absorb rejected candidates. The old 3× ask
    // meant one pinned model had to emit 60 lines (short+long) per call, and
    // that output length — not the pool — dominated the wall clock. The buffer
    // still grows with candidateMultiplier (2→0.5×, 3→1× up to +16, 4→1.5×)
    // but saturates at +8 per type.
    const perProviderNeed = Math.max(1, Math.ceil(shortfall / uniqueProviders.length))
    const buffer = multiplier <= 1
      ? 0
      : Math.min(8 * (multiplier - 1), Math.max(2, Math.ceil(perProviderNeed * (multiplier - 1) * 0.5)))
    const perCallQty = Math.min(50, perProviderNeed + buffer)
    // Thinking-capable models (opus-5 / sonnet-5.5) can spend the default
    // budget on reasoning and return no text at all; scale the budget with the
    // number of candidates asked for.
    const maxTokens = Math.min(8192, 2500 + perCallQty * 140)
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
      fixLines,
      targets,
      direction: directionBrief(attempt),
      rejectedSamples: [...rejectedSamples]
    })
    const roundStart = { attempt, providers: uniqueProviders.map((provider) => provider.name), asked: perCallQty }
    const roundStartedAt = Date.now()
    let roundShort = 0
    let roundLong = 0
    let roundScoredCandidates = 0
    const controllers = new Map<string, AbortController>()
    // The round is done as soon as the remaining shortfall is covered by what
    // arrived so far. At that point the slowest models are cancelled, so the
    // round costs the fastest model's latency instead of the straggler's.
    const enough = () =>
      (wantShort === 0 || acceptedShort + roundShort >= wantShort) &&
      (wantLong === 0 || acceptedLong + roundLong >= wantLong)
    await Promise.all(
      uniqueProviders.map(async (provider) => {
        const controller = new AbortController()
        controllers.set(provider.id, controller)
        if (enough()) return
        const callStartedAt = Date.now()
        const result = await callCopyModel(deps.fetchImpl, provider, {
          system: '你是广告文案生成器，只输出 JSON，不输出解释。',
          prompt,
          temperature: 0.95,
          maxTokens,
          signal: controller.signal,
          timeoutMs: COPY_CALL_TIMEOUT_MS
        })
        timings.push({
          name: provider.name,
          model: provider.model,
          attempt,
          ms: Date.now() - callStartedAt,
          status: controller.signal.aborted ? 'cancelled' : result.ok ? 'ok' : (result.error ?? 'error')
        })
        // A straggler we cancelled ourselves is not a failed provider.
        if (controller.signal.aborted) return
        if (!result.ok || !result.text) {
          failedCounts.set(provider.id, (failedCounts.get(provider.id) ?? 0) + 1)
          providerErrors.push({ name: provider.name, model: provider.model, attempt, error: result.error ?? 'empty-response' })
          return
        }
        failedCounts.set(provider.id, 0)
        const normalized = normalizeModelOutput(result.text, { short: SHORT_MAX_BYTES, long: LONG_MAX_BYTES })
        roundScoredCandidates += normalized.shorts.length + normalized.longs.length
        for (const text of normalized.shorts) {
          const item = scoreCopyItem(text, { type: 'short', maxBytes: SHORT_MAX_BYTES, language, benefits, brandTerms, targets })
          shortPool.push(item)
          if (item.accepted) {
            if (acceptUnique('short', text)) roundShort++
          } else {
            noteFailure(failureCounts, item, targets)
            if (rejectedSamples.length < 12) rejectedSamples.push(`[short] ${text.slice(0, 80)}`)
          }
        }
        for (const text of normalized.longs) {
          const item = scoreCopyItem(text, { type: 'long', maxBytes: LONG_MAX_BYTES, language, benefits, brandTerms, targets })
          longPool.push(item)
          if (item.accepted) {
            if (acceptUnique('long', text)) roundLong++
          } else {
            noteFailure(failureCounts, item, targets)
            if (rejectedSamples.length < 12) rejectedSamples.push(`[long] ${text.slice(0, 80)}`)
          }
        }
        if (enough()) {
          for (const other of controllers.values()) other.abort()
        }
      })
    )
    acceptedShort += roundShort
    acceptedLong += roundLong
    retryHistory.push({ ...roundStart, acceptedShort: roundShort, acceptedLong: roundLong, ms: Date.now() - roundStartedAt })
    // Only evaluated copy can prove that a creative direction is stuck.
    // Transport/provider failures must not stop rotation before a healthy
    // member gets its attempt. maxAttempts still bounds recovery work.
    if (roundShort + roundLong > 0) zeroStreak = 0
    else if (roundScoredCandidates > 0) zeroStreak += 1
    if (zeroStreak >= 2) {
      stagnated = true
      break
    }
  }

  const shortSelection = wantShort > 0 ? selectTopN(shortPool, 'short', wantShort) : { selected: [], rejected: [] }
  const longSelection = wantLong > 0 ? selectTopN(longPool, 'long', wantLong) : { selected: [], rejected: [] }
  const anyOk = shortSelection.selected.length > 0 || longSelection.selected.length > 0
  const missingShort = Math.max(0, wantShort - shortSelection.selected.length)
  const missingLong = Math.max(0, wantLong - longSelection.selected.length)
  const incomplete = missingShort > 0 || missingLong > 0
  const fulfilled = !incomplete
  const dominant = dominantFailure(failureCounts)
  // The caller (skill/tool docs) branches on `fulfilled` and reads `diagnosis`
  // whenever anything is short — including a partial success, where the old
  // payload carried neither field.
  const diagnosis = { dominant, failures: failureCounts, providerErrors: providerErrors.length, stagnated }
  return {
    ok: anyOk,
    fulfilled,
    ...(anyOk ? {} : { error: 'no-copy-passed' }),
    ...(incomplete
      ? {
          incomplete: { short: missingShort, long: missingLong },
          next_steps: nextStepsFor(dominant),
          diagnosis,
          hint: '缺口部分不要用对话模型补写：如实说明还差几条，并按 next_steps 调整后再次调用本工具。'
        }
      : {}),
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
      rejectedLong: longSelection.rejected.length,
      stagnated,
      failures: failureCounts,
      durationMs: Date.now() - startedAt
    },
    provider_pool: {
      size: members.length,
      strategy: stickyFallback ? `${strategy}_fallback` : strategy,
      agentId: agentId || undefined,
      assignedIndex,
      unhealthy: [...failedCounts]
        .filter(([, count]) => count >= 2)
        .map(([id]) => members.find((member) => member.id === id)?.name ?? id)
    },
    provider_errors: providerErrors,
    timings,
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
