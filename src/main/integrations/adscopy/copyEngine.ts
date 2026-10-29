/**
 * Deterministic ad-copy engine — a faithful port of the factory worker's
 * score-control core (ads-tool-factory-share-kit worker_api_template.js):
 * byte counting, five-dimension scoring, financial compliance, top-N
 * selection, model-output normalization and retry helpers. Pure functions,
 * no I/O — the ads-copy bridge feeds it candidates and enforces the results.
 *
 * Worker line references are noted per section (W:###).
 */

// ---------------------------------------------------------------------------
// Byte counting (W:373-377): CJK/fullwidth (>127) counts as 2 bytes.
// ---------------------------------------------------------------------------

export function countBytes(text: string): number {
  let total = 0
  for (let i = 0; i < text.length; i++) total += text.charCodeAt(i) > 127 ? 2 : 1
  return total
}

// ---------------------------------------------------------------------------
// Scoring lexicons (W:379-394) with caller benefit/brand term merge.
// ---------------------------------------------------------------------------

interface ScoreLexicon {
  hook: string[]
  cta: string[]
  forbidden: string[]
  benefit: string[]
  brand: string[]
}

const SCORE_LANGUAGE_TERMS: Record<string, { hook: string[]; cta: string[]; forbidden: string[] }> = {
  en: {
    hook: ['discover', 'find', 'explore', 'unlock', 'join', 'get', 'try', 'now', 'new', 'best', 'why', 'how', 'what'],
    cta: ['download', 'install', 'get', 'try', 'join', 'start', 'explore', 'discover', 'shop', 'learn', 'open', 'use', 'sign up'],
    forbidden: ['miracle', 'guaranteed', 'risk-free', 'number one', 'safest']
  },
  es: {
    hook: ['descubre', 'descarga', 'instala', 'encuentra', 'conoce', 'prueba', 'usa', 'empieza', 'hoy', 'ahora', 'facil', 'claro', 'por que', 'como'],
    cta: ['descarga', 'instala', 'usa', 'empieza', 'prueba', 'conoce', 'abre', 'compra', 'aprende', 'registra'],
    forbidden: ['milagro', 'garantizado', 'sin riesgo', 'numero 1', 'el mejor']
  },
  'es-MX': {
    hook: ['descubre', 'descarga', 'instala', 'encuentra', 'conoce', 'prueba', 'usa', 'empieza', 'hoy', 'ahora', 'facil', 'claro', 'por que', 'como'],
    cta: ['descarga', 'instala', 'usa', 'empieza', 'prueba', 'conoce', 'abre', 'compra', 'aprende', 'registra'],
    forbidden: ['milagro', 'garantizado', 'sin riesgo', 'numero 1', 'el mejor']
  },
  'zh-CN': {
    hook: ['发现', '探索', '免费', '立即', '最好', '真实', '加入', '获取', '了解', '开始'],
    cta: ['下载', '安装', '开始', '加入', '探索', '发现', '立即', '体验', '注册'],
    forbidden: ['保证', '无风险', '第一', '最安全', '稳赚']
  },
  'zh-TW': {
    hook: ['發現', '探索', '免費', '立即', '最好', '真實', '加入', '取得', '了解', '開始'],
    cta: ['下載', '安裝', '開始', '加入', '探索', '發現', '立即', '體驗', '註冊'],
    forbidden: ['保證', '無風險', '第一', '最安全', '穩賺']
  },
  fr: {
    hook: ['découvrez', 'trouvez', 'gratuit', 'maintenant', 'meilleur', 'vrai', 'nouveau', 'pourquoi', 'comment'],
    cta: ['téléchargez', 'installez', 'commencez', 'découvrez', 'essayez', 'ouvrez', 'inscrivez'],
    forbidden: ['miracle', 'garanti', 'sans risque', 'numéro 1', 'le meilleur']
  },
  de: {
    hook: ['entdecke', 'finde', 'kostenlos', 'jetzt', 'beste', 'echte', 'neu', 'warum', 'wie'],
    cta: ['herunterladen', 'installieren', 'jetzt', 'starten', 'entdecken', 'ausprobieren', 'öffnen'],
    forbidden: ['garantiert', 'risikofrei', 'nummer 1', 'am sichersten']
  }
}

/** W:443-451 — lowercase, strip diacritics/¡!, collapse whitespace. */
export function normalizeForScore(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¡!]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildLexicon(language: string, benefits: string[], brandTerms: string[]): ScoreLexicon {
  const key = language || 'en'
  const base = SCORE_LANGUAGE_TERMS[key] ?? SCORE_LANGUAGE_TERMS[key.split('-')[0]] ?? SCORE_LANGUAGE_TERMS.en
  // W:391 — caller benefits split into words (>2 chars) double as relevance
  // terms; the worker's extra score_terms merge rides the same list here.
  const benefitWords = [...new Set(benefits.flatMap((value) => normalizeForScore(value).split(/[^\p{L}\p{N}]+/u)).filter((word) => word.length > 2))]
  return { hook: base.hook, cta: base.cta, benefit: benefitWords, brand: brandTerms.map(normalizeForScore).filter(Boolean), forbidden: base.forbidden }
}

// ---------------------------------------------------------------------------
// Targets (W:396-404) and the public scoring surface.
// ---------------------------------------------------------------------------

export interface CopyScoreTargets {
  hook?: number
  relevance?: number
  cta?: number
  space?: number
  total?: number
}

export const DEFAULT_TARGETS: Required<CopyScoreTargets> = {
  hook: 6,
  relevance: 6,
  cta: 7,
  space: 5,
  total: 7
}

function clampTarget(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN
  return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : fallback
}

export function resolveTargets(targets: CopyScoreTargets): Required<CopyScoreTargets> {
  return {
    hook: clampTarget(targets.hook, DEFAULT_TARGETS.hook),
    relevance: clampTarget(targets.relevance, DEFAULT_TARGETS.relevance),
    cta: clampTarget(targets.cta, DEFAULT_TARGETS.cta),
    space: clampTarget(targets.space, DEFAULT_TARGETS.space),
    total: clampTarget(targets.total, DEFAULT_TARGETS.total)
  }
}

export interface ScoredCopyItem {
  text: string
  bytes: number
  scores: { hook: number; relevance: number; cta: number; space: number; brand: number; total: number }
  accepted: boolean
  rejectReason?: string
}

/** W:453-456 — benefit hits 0/1/3/5 → 2/6/8/10. */
function relevanceScore(normalizedText: string, benefitTerms: string[]): number {
  const hits = benefitTerms.filter((term) => term && normalizedText.includes(normalizeForScore(term))).length
  return Math.min(10, hits >= 5 ? 10 : hits >= 3 ? 8 : hits >= 1 ? 6 : 2)
}

/** W:458-465 — 4 + brand≤3 + concrete≤3 − forbidden×2≤4, clamped 0-10. */
function brandFitScore(normalizedText: string, brandTerms: string[], benefitTerms: string[], forbidden: string[]): number {
  const brandHits = brandTerms.filter((term) => normalizedText.includes(normalizeForScore(term))).length
  const concreteHits = benefitTerms.filter((term) => normalizedText.includes(normalizeForScore(term))).length
  const forbiddenHits = forbidden.filter((term) => normalizedText.includes(normalizeForScore(term))).length
  const score = 4 + Math.min(3, brandHits) + Math.min(3, concreteHits) - Math.min(4, forbiddenHits * 2)
  return Math.max(0, Math.min(10, score))
}

// ---------------------------------------------------------------------------
// Financial compliance (W:478-486).
// ---------------------------------------------------------------------------

const FINANCIAL_FORBIDDEN_PATTERNS: RegExp[] = [
  /\b(fdic|fca|mas|pci|soc\s*2|iso\s*27001|bank[-\s]?grade|licensed|regulated|certified|insured)\b/i,
  /\b(bank partner|bank partnership|official partner|visa partner|mastercard partner|approved lender)\b/i,
  /\b(no fees?|zero fees?|free transfers?|lowest fees?|best rates?|better exchange rates?|no hidden fees?)\b/i,
  /\b(instant transfer|instant payout|arrives instantly|same[-\s]?day transfer|real[-\s]?time transfer)\b/i,
  /\b(guaranteed approval|instant approval|pre[-\s]?approved|risk[-\s]?free|guaranteed savings?|guaranteed returns?|earn yields?|investment returns?)\b/i,
  /\b(safest|fully secure|secure by default|encrypted payments?|military[-\s]?grade)\b/i,
  /牌照|持牌|监管认证|银行合作|官方合作|安全认证|银行级|零手续费|免手续费|最低费率|最优汇率|实时到账|秒到账|即时到账|保证通过| guaranteed approval|无风险|保证省钱|稳赚|收益|返现/i
]

export function financialComplianceViolations(text: string): string[] {
  return FINANCIAL_FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source.slice(0, 80))
}

// ---------------------------------------------------------------------------
// scoreCopyItem (W:406-441, 495-512) — one candidate, fully annotated.
// ---------------------------------------------------------------------------

export function scoreCopyItem(
  text: string,
  opts: { type: 'short' | 'long'; maxBytes: number; language: string; benefits: string[]; brandTerms: string[]; targets: Required<CopyScoreTargets> }
): ScoredCopyItem {
  const source = String(text ?? '')
  const lexicon = buildLexicon(opts.language, opts.benefits, opts.brandTerms)
  const normalized = normalizeForScore(source)
  const bytes = countBytes(source)

  // Hook (W:415-419): hook word in first third +6, digit in first half +2,
  // question mark +2, capped at 10.
  const firstThird = normalized.slice(0, Math.ceil(normalized.length / 3))
  const hasHook = lexicon.hook.some((word) => firstThird.includes(normalizeForScore(word)))
  const hasNumber = /\d/.test(source.slice(0, Math.ceil(source.length / 2)))
  const hasQuestion = source.includes('?')
  const hook = Math.min(10, (hasHook ? 6 : 0) + (hasNumber ? 2 : 0) + (hasQuestion ? 2 : 0))

  const relevance = relevanceScore(normalized, lexicon.benefit)

  // CTA (W:423-424): lexicon verb → 10; else short 4 / long 2.
  const hasCta = lexicon.cta.some((word) => normalized.includes(normalizeForScore(word)))
  const cta = hasCta ? 10 : opts.type === 'short' ? 4 : 2

  // Space (W:426-427): over limit 0; ≥75% 10; ≥55% 7; ≥35% 4; else 2.
  const pct = bytes / opts.maxBytes
  const space = bytes > opts.maxBytes ? 0 : pct >= 0.75 ? 10 : pct >= 0.55 ? 7 : pct >= 0.35 ? 4 : 2

  const brand = brandFitScore(normalized, lexicon.brand, lexicon.benefit, lexicon.forbidden)
  // Weighted total (W:429): 0.22/0.34/0.18/0.10/0.16.
  const total = Math.round(hook * 0.22 + relevance * 0.34 + cta * 0.18 + space * 0.1 + brand * 0.16)

  const violations = financialComplianceViolations(source)
  const withinBytes = bytes <= opts.maxBytes
  const passesFloors =
    hook >= opts.targets.hook &&
    relevance >= opts.targets.relevance &&
    cta >= opts.targets.cta &&
    space >= opts.targets.space &&
    total >= opts.targets.total
  const accepted = withinBytes && violations.length === 0 && passesFloors
  return {
    text: source,
    bytes,
    scores: { hook, relevance, cta, space, brand, total },
    accepted,
    ...(accepted ? {} : { rejectReason: rejectReasonFor(withinBytes, violations, passesFloors) })
  }
}

function rejectReasonFor(withinBytes: boolean, violations: string[], passesFloors: boolean): string {
  if (!withinBytes) return 'over_limit'
  if (violations.length > 0) return 'financial_compliance_violation'
  if (!passesFloors) return 'below_score_targets'
  return 'not_needed'
}

// ---------------------------------------------------------------------------
// Top-N selection (W:662-705, 713-721): dedupe by type::lower(text), sort by
// the weighted sort value, fill to qty, replace the worst when a better
// candidate arrives.
// ---------------------------------------------------------------------------

function scoreSortValue(item: ScoredCopyItem): number {
  const s = item.scores
  return s.total * 100 + s.hook * 8 + s.relevance * 6 + s.cta * 4 + s.space * 2
}

export function selectTopN(items: ScoredCopyItem[], type: 'short' | 'long', qty: number): { selected: ScoredCopyItem[]; rejected: ScoredCopyItem[] } {
  const seen = new Set<string>()
  const selected: ScoredCopyItem[] = []
  const rejected: ScoredCopyItem[] = []
  const keyOf = (item: ScoredCopyItem) => `${type}::${item.text.toLowerCase()}`

  const ranked = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => scoreSortValue(b.item) - scoreSortValue(a.item) || a.index - b.index)

  for (const { item } of ranked) {
    const key = keyOf(item)
    if (seen.has(key)) {
      rejected.push({ ...item, rejectReason: 'not_needed' })
      continue
    }
    if (selected.length < qty) {
      seen.add(key)
      selected.push(item)
      continue
    }
    // Full: replace the current worst only if this candidate beats it.
    let worstIndex = -1
    let worstScore = Infinity
    selected.forEach((candidate, index) => {
      const value = scoreSortValue(candidate)
      if (value < worstScore) {
        worstScore = value
        worstIndex = index
      }
    })
    if (worstIndex >= 0 && scoreSortValue(item) > worstScore) {
      const removed = selected[worstIndex]
      seen.delete(keyOf(removed))
      seen.add(key)
      rejected.push({ ...removed, rejectReason: 'not_needed' })
      selected[worstIndex] = item
    } else {
      rejected.push({ ...item, rejectReason: item.accepted ? 'not_needed' : item.rejectReason ?? 'not_needed' })
    }
  }
  return { selected, rejected }
}

// ---------------------------------------------------------------------------
// Model-output normalization (W:525-632): think-block stripping, fenced
// blocks, brace-matched first JSON object, key aliases, nested unwrapping,
// plain-line fallback. Never throws — an unparseable response yields empty
// arrays so the bridge can fall back or retry.
// ---------------------------------------------------------------------------

const SHORT_KEYS = ['short', 'shorts', 'headlines', 'short_headlines', 'shortHeadlines', 'short_titles', 'shortTitles', 'titles']
const LONG_KEYS = ['long', 'longs', 'descriptions', 'long_descriptions', 'longDescriptions', 'long_copy', 'longCopy', 'desc', 'description']
const NESTED_KEYS = ['data', 'result', 'results', 'items', 'copies', 'copy']
const COPY_CAP = 50
/** W:619 — pure header/label lines that carry no copy. */
// eslint-disable-next-line no-control-regex
const LABEL_LINE = /^(short|long|headline|description|json|output|result|以下|这里|当然|好的)[:：]?$/i

/** W:623-628 — strip wrapping quotes/backticks, bullets, numbering, labels. */
function cleanCopyLine(line: string): string {
  return String(line ?? '')
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, '')
    .replace(/^\s*(?:[-*•]|\d+[\).、]|[A-Za-z]\)|短标题|长描述|标题|描述|headline|description|short|long)\s*[:：-]?\s*/i, '')
    .trim()
}

function splitPlainCopyLines(text: string): string[] {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, ''))
    .split(/\r?\n|[；;]/)
    .map(cleanCopyLine)
    .filter((line) => line && !LABEL_LINE.test(line))
    .filter((line) => !/^\{|\}|\[|\]$/.test(line))
}

function itemText(item: unknown): string {
  if (typeof item === 'string') return cleanCopyLine(item)
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>
    return cleanCopyLine(String(record.text ?? record.copy ?? record.content ?? record.title ?? record.description ?? ''))
  }
  return ''
}

function classifyLines(lines: string[], maxBytes: { short: number; long: number }): { shorts: string[]; longs: string[] } {
  const shorts: string[] = []
  const longs: string[] = []
  for (const line of lines) {
    if (!line) continue
    if (countBytes(line) <= maxBytes.short) {
      if (shorts.length < COPY_CAP) shorts.push(line)
    } else if (longs.length < COPY_CAP) longs.push(line)
  }
  return { shorts, longs }
}

/** W:547-564 — brace-matched extraction of the first complete JSON object. */
function extractFirstJsonObject(text: string): string {
  let start = -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (start < 0) {
      if (ch === '{') {
        start = i
        depth = 1
      }
      continue
    }
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (depth === 0) return text.slice(start, i + 1)
  }
  return ''
}

function normalizeCopyValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(itemText).filter(Boolean)
  if (typeof value === 'string') return splitPlainCopyLines(value)
  return []
}

function normalizeParsedJson(parsed: unknown, maxBytes: { short: number; long: number }): { shorts: string[]; longs: string[] } | null {
  if (Array.isArray(parsed)) {
    return classifyLines(parsed.map(itemText).filter(Boolean), maxBytes)
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const shorts: string[] = []
  const longs: string[] = []
  for (const key of SHORT_KEYS) {
    if (record[key] !== undefined) {
      shorts.push(...normalizeCopyValue(record[key]))
      break
    }
  }
  for (const key of LONG_KEYS) {
    if (record[key] !== undefined) {
      longs.push(...normalizeCopyValue(record[key]))
      break
    }
  }
  if (shorts.length > 0 || longs.length > 0) return classifyInto(shorts, longs, maxBytes)
  for (const key of NESTED_KEYS) {
    if (record[key] === undefined || record[key] === null) continue
    const nested = normalizeParsedJson(record[key], maxBytes)
    if (nested && (nested.shorts.length > 0 || nested.longs.length > 0)) return nested
  }
  if (typeof record.text === 'string') return classifyLines(splitPlainCopyLines(record.text), maxBytes)
  return null
}

function classifyInto(shorts: string[], longs: string[], maxBytes: { short: number; long: number }): { shorts: string[]; longs: string[] } {
  // Keyed aliases carry their type (W:566-571 keeps parsed.short as shorts
  // regardless of length — over-limit candidates are rejected later by
  // scoring, so truncating here would hide real violations).
  void maxBytes
  return {
    shorts: shorts.filter(Boolean).slice(0, COPY_CAP),
    longs: longs.filter(Boolean).slice(0, COPY_CAP)
  }
}

export function normalizeModelOutput(raw: string, maxBytes: { short: number; long: number }): { shorts: string[]; longs: string[] } {
  const source = String(raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '```')
    .trim()
  const candidates: string[] = []
  for (const block of source.match(/```[\s\S]*?```/g) ?? []) {
    candidates.push(block.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim())
  }
  candidates.push(source)
  for (const text of candidates) {
    try {
      const direct = normalizeParsedJson(JSON.parse(text), maxBytes)
      if (direct) return direct
    } catch {
      // fall through to brace extraction
    }
    const extracted = extractFirstJsonObject(text)
    if (extracted) {
      try {
        const nested = normalizeParsedJson(JSON.parse(extracted), maxBytes)
        if (nested) return nested
      } catch {
        // try the next candidate
      }
    }
  }
  return classifyLines(splitPlainCopyLines(source), maxBytes)
}

// ---------------------------------------------------------------------------
// Retry helpers (W:759-822, 893-936).
// ---------------------------------------------------------------------------

export interface CopyCategoryRequest {
  type: 'short' | 'long'
  qty: number
}

/** W:913-917 — remaining candidates needed this attempt (never below 1). */
export function computeShortfall(haveShort: number, haveLong: number, categories: CopyCategoryRequest[]): number {
  const desiredShort = categories.filter((c) => c.type !== 'long').reduce((acc, c) => acc + c.qty, 0)
  const desiredLong = categories.filter((c) => c.type !== 'short').reduce((acc, c) => acc + c.qty, 0)
  return Math.max(
    desiredShort > 0 ? Math.max(1, desiredShort - haveShort) : 0,
    desiredLong > 0 ? Math.max(1, desiredLong - haveLong) : 0,
    1
  )
}

/** W:924 — round-robin across the pool per category/attempt/offset. */
export function providerRotationIndex(poolLength: number, categoryIndex: number, attempt: number, offset = 0): number {
  if (poolLength <= 0) return 0
  return (((categoryIndex + attempt - 1 + offset) % poolLength) + poolLength) % poolLength
}

/** W:802-808 — five rotating creative frameworks (product placeholder kept). */
const CREATIVE_FRAMEWORKS: readonly string[] = [
  'Use a direct-action hook in the requested language and put the action in the first third of every line.',
  'Use curiosity hooks with a natural question or useful number early, then tie directly to the selected product function.',
  "Use problem-solution copy: start with the user's need, then one concrete product function, then a clear CTA verb in the requested language.",
  'Use social-discovery copy only when it fits the product: concrete user action, benefit keyword, and no unsupported claims.',
  'Use utility-first copy: what the user can do today, concrete benefit words, and a simple CTA.'
]

export function creativeFrameworkBrief(attempt: number, categoryIndex: number): string {
  const index = (((attempt + categoryIndex - 1) % CREATIVE_FRAMEWORKS.length) + CREATIVE_FRAMEWORKS.length) % CREATIVE_FRAMEWORKS.length
  return CREATIVE_FRAMEWORKS[index]
}

/** W:780-799 — at most 3 fix lines, ranked by failure count. */
const FIX_ACTIONS: Record<string, string> = {
  over: 'Shorten first: remove side clauses, adjectives, repeated brand words, and keep one benefit plus one CTA only.',
  compliance: 'Remove unsupported finance claims: no license, bank partnership, security certification, instant arrival, fee advantage, guaranteed approval, risk-free, or guaranteed savings language.',
  hook: 'Strengthen the opening with a natural action word, a simple question, or a useful number in the requested language within the first third of the copy.',
  rel: 'Increase relevance by naming one concrete customer-confirmed function from the selected benefits in the requested language.',
  cta: 'Add a clear, natural action verb for the requested language and market near the end.',
  space: 'Improve byte utilization: target roughly 80-95% of the byte limit without exceeding it; add one concrete function word if too short.',
  total: 'Raise overall quality: combine a stronger hook, one exact benefit keyword, and a direct CTA instead of changing only wording.'
}

export function targetedFixLines(failureCounts: Record<string, number>): string[] {
  return Object.entries(failureCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key]) => FIX_ACTIONS[key])
    .filter((line): line is string => Boolean(line))
}
