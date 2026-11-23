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
// Scoring lexicons (W:379-394, extended) with caller benefit/brand term merge.
// Coverage targets the mainstream ad markets: the six worker lexicons plus
// SEA (fil/th/vi/id/ms), LatAm/Europe (pt/it/nl/pl/tr/ru), MENA/India (ar/hi)
// and CJK (ja/ko). Every entry must be natural ad-copy phrasing, not
// dictionary transliterations — the scorer substring-matches normalized text.
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
  },
  fil: {
    hook: ['libre', 'tuklasin', 'bagong', 'ngayon', 'madali', 'bakit', 'paano', 'subukan', 'free', 'discover'],
    cta: ['i-download', 'mag-download', 'download', 'i-install', 'install', 'sumali', 'subukan', 'simulan', 'kunin', 'mag-register', 'mag-sign up', 'try'],
    forbidden: ['garantisado', 'walang panganib', 'numero uno', 'pinakaligtas', 'milagro', 'guaranteed', 'risk-free', 'safest', 'number one']
  },
  th: {
    hook: ['ฟรี', 'ใหม่', 'ดีที่สุด', 'ทันที', 'วันนี้', 'ง่าย', 'ลอง', 'ค้นพบ', 'ทำไม', 'ยังไง', 'free'],
    cta: ['ดาวน์โหลด', 'โหลด', 'ติดตั้ง', 'เริ่ม', 'เริ่มต้น', 'ใช้งาน', 'ลอง', 'สมัคร', 'เข้าร่วม'],
    forbidden: ['การันตี', 'รับประกัน', 'ไม่มีความเสี่ยง', 'ปลอดภัยที่สุด', 'อันดับ 1', 'miracle', 'guaranteed']
  },
  vi: {
    hook: ['khám phá', 'miễn phí', 'ngay', 'mới', 'tốt nhất', 'dễ', 'thử', 'tại sao', 'cách', 'nhận'],
    cta: ['tải', 'cài đặt', 'bắt đầu', 'đăng ký', 'tham gia', 'dùng thử', 'dùng', 'mở', 'khám phá'],
    forbidden: ['đảm bảo', 'không rủi ro', 'số 1', 'an toàn nhất', 'phép màu']
  },
  id: {
    hook: ['gratis', 'temukan', 'jelajahi', 'baru', 'terbaik', 'sekarang', 'mudah', 'coba', 'kenapa', 'mengapa', 'cara', 'dapatkan'],
    cta: ['unduh', 'instal', 'pasang', 'mulai', 'coba', 'gabung', 'bergabung', 'daftar', 'buka', 'pakai', 'gunakan', 'dapatkan'],
    forbidden: ['dijamin', 'tanpa risiko', 'nomor 1', 'paling aman', 'ajaib']
  },
  ms: {
    hook: ['percuma', 'temui', 'terbaik', 'sekarang', 'mudah', 'baru', 'cuba', 'kenapa', 'cara', 'dapatkan'],
    cta: ['muat turun', 'pasang', 'mula', 'cuba', 'sertai', 'daftar', 'buka', 'guna', 'gunakan', 'dapatkan'],
    forbidden: ['dijamin', 'tanpa risiko', 'nombor 1', 'paling selamat', 'ajaib']
  },
  pt: {
    hook: ['descubra', 'grátis', 'agora', 'novo', 'nova', 'fácil', 'experimente', 'por que', 'porque', 'como', 'ganhe'],
    cta: ['baixe', 'baixar', 'instale', 'comece', 'experimente', 'junte-se', 'cadastre-se', 'abra', 'use', 'assine', 'conheça'],
    forbidden: ['garantido', 'sem risco', 'número 1', 'milagre', 'o melhor']
  },
  ja: {
    hook: ['無料', '今すぐ', '今', '新', '簡単', '発見', '試す', 'なぜ', '方法'],
    cta: ['ダウンロード', 'インストール', '始める', '登録', '試す', '使う', '開く', '参加', 'チェック', 'ゲット'],
    forbidden: ['保証', '必ず', 'リスクなし', 'No.1', '奇跡']
  },
  ko: {
    hook: ['무료', '지금', '새로운', '간편', '쉽게', '발견', '인기', '왜', '방법'],
    cta: ['다운로드', '설치', '시작', '가입', '이용', '열기', '체험', '받기', '도전'],
    forbidden: ['보장', '무위험', '위험 없음', '1등', '가장 안전', '기적']
  },
  ru: {
    hook: ['открой', 'бесплатно', 'сейчас', 'новый', 'новинка', 'лучший', 'легко', 'почему', 'как', 'попробуй'],
    cta: ['скачать', 'скачай', 'установи', 'начни', 'попробуй', 'присоединяйся', 'зарегистрируйся', 'открой', 'используй', 'получи'],
    forbidden: ['гарантия', 'без риска', 'номер 1', 'самый надёжный', 'чудо']
  },
  ar: {
    hook: ['اكتشف', 'مجان', 'الآن', 'جديد', 'الأفضل', 'سهل', 'لماذا', 'كيف', 'جرّب'],
    cta: ['حمّل', 'تحميل', 'ثبّت', 'ابدأ', 'جرّب', 'انضم', 'سجّل', 'افتح', 'استخدم', 'احصل'],
    forbidden: ['مضمون', 'بدون مخاطر', 'الأكثر أماناً', 'معجزة']
  },
  tr: {
    hook: ['keşfet', 'ücretsiz', 'şimdi', 'yeni', 'kolay', 'neden', 'nasıl', 'dene'],
    cta: ['indir', 'yükle', 'başla', 'dene', 'katıl', 'kaydol', 'kayıt ol', 'aç', 'kullan'],
    forbidden: ['garantili', 'risksiz', '1 numara', 'en güvenli', 'mucize']
  },
  it: {
    hook: ['scopri', 'gratis', 'ora', 'adesso', 'nuovo', 'nuova', 'facile', 'perché', 'come', 'prova'],
    cta: ['scarica', 'installa', 'inizia', 'prova', 'unisciti', 'registrati', 'apri', 'usa', 'ottieni'],
    forbidden: ['miracolo', 'garantito', 'senza rischi', 'numero 1', 'il più sicuro']
  },
  hi: {
    hook: ['मुफ़्त', 'अभी', 'नया', 'सबसे अच्छा', 'आसान', 'क्यों', 'कैसे', 'खोजें', 'आज़माएँ'],
    cta: ['डाउनलोड', 'इंस्टॉल', 'शुरू', 'आज़माएँ', 'जुड़ें', 'रजिस्टर', 'खोलें', 'पाएं', 'पाएँ'],
    forbidden: ['गारंटी', 'बिना जोखिम', 'नंबर 1', 'सबसे सुरक्षित', 'चमत्कार']
  },
  nl: {
    hook: ['ontdek', 'gratis', 'nu', 'nieuw', 'makkelijk', 'waarom', 'hoe', 'probeer'],
    cta: ['download', 'installeer', 'begin', 'start', 'probeer', 'word lid', 'registreer', 'open', 'gebruik', 'krijg'],
    forbidden: ['gegarandeerd', 'risicovrij', 'nummer 1', 'veiligste', 'wonder']
  },
  pl: {
    hook: ['odkryj', 'darmowy', 'za darmo', 'teraz', 'nowy', 'najlepszy', 'łatwo', 'dlaczego', 'jak', 'spróbuj'],
    cta: ['pobierz', 'zainstaluj', 'zacznij', 'spróbuj', 'dołącz', 'zarejestruj', 'otwórz', 'użyj', 'zdobądź'],
    forbidden: ['gwarantowany', 'bez ryzyka', 'numer 1', 'najbezpieczniejszy', 'cud']
  }
}

/** Legacy/region language codes that resolve to a lexicon under another key. */
const SCORE_LANGUAGE_ALIASES: Record<string, string> = {
  tl: 'fil',
  'tl-ph': 'fil',
  'fil-ph': 'fil',
  in: 'id',
  zh: 'zh-CN',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  'zh-hant': 'zh-TW',
  'zh-hans': 'zh-CN'
}

/**
 * Share of the weighted total still enforced when no lexicon matches the
 * language: relevance (.34) + space (.10) + brand (.16) stay hard-gated,
 * hook (.22) and CTA (.18) floors are waived because they cannot be judged
 * in an unlisted language.
 */
const DEGRADED_TOTAL_KEEP = 0.6

type LexiconMode = 'full' | 'degraded'

interface LexiconResolution {
  /** Lexicon actually applied (always present in SCORE_LANGUAGE_TERMS). */
  key: string
  mode: LexiconMode
}

/** Detect the script of the copy itself and map it to a lexicon language. */
function detectScriptKey(text: string): string | null {
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'ja'
  if (/\p{Script=Hangul}/u.test(text)) return 'ko'
  if (/\p{Script=Thai}/u.test(text)) return 'th'
  if (/\p{Script=Arabic}/u.test(text)) return 'ar'
  if (/\p{Script=Devanagari}/u.test(text)) return 'hi'
  if (/\p{Script=Cyrillic}/u.test(text)) return 'ru'
  if (/\p{Script=Han}/u.test(text)) return 'zh-CN'
  return null
}

/**
 * Resolution order: exact code → known alias → base code (es-MX→es) →
 * base alias (tl-PH→fil) → script sniffed from the copy (language "zh" with
 * Thai text still scores Thai) → English fallback marked degraded. Degraded
 * never zeroes a candidate: the hook/CTA floors are waived downstream so an
 * unlisted language scores on relevance/space/brand instead of failing all.
 */
/** Lowercased language code → canonical SCORE_LANGUAGE_TERMS key. */
const TERMS_BY_LOWER = new Map(Object.keys(SCORE_LANGUAGE_TERMS).map(key => [key.toLowerCase(), key]))

/** Case-insensitive lexicon lookup: 'zh-tw' resolves to the canonical 'zh-TW'. */
function lexiconKeyFor(code: string): string | null {
  const lower = code.toLowerCase()
  const alias = SCORE_LANGUAGE_ALIASES[lower]
  return TERMS_BY_LOWER.get(lower) ?? (alias ? TERMS_BY_LOWER.get(alias.toLowerCase()) ?? null : null)
}

function resolveLexicon(language: string, text?: string): LexiconResolution {
  const key = String(language ?? '').trim().toLowerCase().replace(/_/g, '-') || 'en'
  const direct = lexiconKeyFor(key)
  if (direct) return { key: direct, mode: 'full' }
  const viaBase = lexiconKeyFor(key.split('-')[0])
  if (viaBase) return { key: viaBase, mode: 'full' }
  const scriptKey = detectScriptKey(String(text ?? ''))
  if (scriptKey) return { key: scriptKey, mode: 'full' }
  return { key: 'en', mode: 'degraded' }
}

/**
 * The exact words the deterministic scorer rewards, per language. Prompt
 * builders embed this so a model writes copy that can actually clear the
 * floors instead of guessing at the rubric. An unlisted language returns
 * empty hook/cta (so the prompt stops steering toward English words) plus
 * `degraded: true`; the English forbidden list still travels because
 * English leakage is banned in every market.
 */
export function scoringLexiconBrief(language: string): { hook: string[]; cta: string[]; forbidden: string[]; degraded: boolean } {
  const { key, mode } = resolveLexicon(language)
  const base = SCORE_LANGUAGE_TERMS[key]
  return {
    hook: mode === 'full' ? [...base.hook] : [],
    cta: mode === 'full' ? [...base.cta] : [],
    forbidden: [...base.forbidden],
    degraded: mode === 'degraded'
  }
}
/** W:443-451 — lowercase, strip diacritics/¡!, collapse whitespace. */export function normalizeForScore(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¡!]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildLexicon(language: string, text: string, benefits: string[], brandTerms: string[]): ScoreLexicon & { resolution: LexiconResolution } {
  const resolution = resolveLexicon(language, text)
  const base = SCORE_LANGUAGE_TERMS[resolution.key]
  // W:391 — caller benefits split into words (>2 chars) double as relevance
  // terms; the worker's extra score_terms merge rides the same list here.
  // \p{M} keeps combining marks inside words — Thai/Hindi/Arabic diacritics
  // are Mark-category and must not split the term they belong to.
  const benefitWords = [...new Set(benefits.flatMap((value) => normalizeForScore(value).split(/[^\p{L}\p{N}\p{M}]+/u)).filter((word) => word.length > 2))]
  return { hook: base.hook, cta: base.cta, benefit: benefitWords, brand: brandTerms.map(normalizeForScore).filter(Boolean), forbidden: base.forbidden, resolution }
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
  /**
   * full = scored with a matched language lexicon; degraded = the language
   * had no lexicon (hook/CTA floors waived, total floor scaled — see
   * DEGRADED_TOTAL_KEEP), so consumers can report the weaker gate honestly.
   */
  scoringMode: LexiconMode
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
  return financialComplianceMatches(text).map((match) => match.source)
}

/** Pattern hits with the matched phrase — the caller can exempt matches the
 * user themselves confirmed as product facts (see scoreCopyItem). */
export function financialComplianceMatches(text: string): Array<{ source: string; match: string }> {
  const matches: Array<{ source: string; match: string }> = []
  for (const pattern of FINANCIAL_FORBIDDEN_PATTERNS) {
    // EVERY occurrence must be examined: exempting only the first hit let a
    // confirmed "zero fees" mask an unconfirmed "lowest fees" in the same line.
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (const hit of String(text ?? '').matchAll(global)) {
      matches.push({ source: pattern.source.slice(0, 80), match: hit[0] })
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// scoreCopyItem (W:406-441, 495-512) — one candidate, fully annotated.
// ---------------------------------------------------------------------------

export function scoreCopyItem(
  text: string,
  opts: { type: 'short' | 'long'; maxBytes: number; language: string; benefits: string[]; brandTerms: string[]; targets: Required<CopyScoreTargets> }
): ScoredCopyItem {
  const source = String(text ?? '')
  const lexicon = buildLexicon(opts.language, source, opts.benefits, opts.brandTerms)
  const degraded = lexicon.resolution.mode === 'degraded'
  const normalized = normalizeForScore(source)
  const bytes = countBytes(source)

  // Hook (W:415-419): hook word in first third +6, digit in first half +2,
  // question mark +2, capped at 10. Digits include Arabic-Indic, Thai and
  // Devanagari numerals; questions include the Arabic ؟.
  const firstThird = normalized.slice(0, Math.ceil(normalized.length / 3))
  const hasHook = lexicon.hook.some((word) => firstThird.includes(normalizeForScore(word)))
  const hasNumber = /[\d٠-٩۰-۹๐-๙०-९]/.test(source.slice(0, Math.ceil(source.length / 2)))
  const hasQuestion = source.includes('?') || source.includes('؟')
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

  // The financial red line is "绝不编造" — never "绝不提及". A phrase the user
  // themselves put in the product sheet (benefits/brandTerms) is a confirmed
  // fact, not a fabricated claim: a payments product whose confirmed selling
  // point IS "zero fees" must not have every candidate hard-rejected by the
  // very phrase it was told to write. Matches NOT covered by user facts stay
  // hard rejects.
  const confirmedFacts = [...opts.benefits, ...opts.brandTerms].map(normalizeForScore).filter(Boolean)
  const violations = financialComplianceMatches(source)
    .filter((violation) => {
      const matched = normalizeForScore(violation.match)
      return !confirmedFacts.some((fact) => fact.includes(matched))
    })
    .map((violation) => violation.source)
  const withinBytes = bytes <= opts.maxBytes
  // Degraded language: hook/CTA floors are unjudgeable in an unlisted
  // language, so only the text-independent gates (relevance, space, brand
  // forbidden words, financial compliance) stay hard; the total floor scales
  // with the weight actually enforced (DEGRADED_TOTAL_KEEP).
  const totalFloor = degraded ? Math.round(opts.targets.total * DEGRADED_TOTAL_KEEP) : opts.targets.total
  const passesFloors =
    (degraded || hook >= opts.targets.hook) &&
    relevance >= opts.targets.relevance &&
    (degraded || cta >= opts.targets.cta) &&
    space >= opts.targets.space &&
    total >= totalFloor
  const accepted = withinBytes && violations.length === 0 && passesFloors
  return {
    text: source,
    bytes,
    scores: { hook, relevance, cta, space, brand, total },
    accepted,
    scoringMode: lexicon.resolution.mode,
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
    // Only candidates that passed EVERY gate (bytes + compliance + floors)
    // may ship. A rejected line never fills quota or counts as fulfilled —
    // "meets the count" must never smuggle a non-compliant claim through.
    if (!item.accepted) {
      rejected.push(item)
      continue
    }
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
    const asShort = countBytes(line) <= maxBytes.short ? line : fitTrailingPunctuation(line, maxBytes.short)
    if (countBytes(asShort) <= maxBytes.short) {
      if (shorts.length < COPY_CAP) shorts.push(asShort)
    } else {
      const asLong = countBytes(line) <= maxBytes.long ? line : fitTrailingPunctuation(line, maxBytes.long)
      if (longs.length < COPY_CAP) longs.push(asLong)
    }
  }
  return { shorts, longs }
}

/**
 * Models overshoot the cap by a byte or two of trailing punctuation far more
 * often than by whole words (the #1 rejection cause in real runs). Trailing
 * punctuation carries no claim — strip it to rescue small overshoots; a
 * genuinely too-long line is left alone (scoring rejects it honestly).
 */
function fitTrailingPunctuation(line: string, cap: number): string {
  let text = line
  while (countBytes(text) > cap) {
    const trimmed = text.replace(/[。，．、,.;；:！!？?\s—-]+$/u, '')
    if (trimmed === text || trimmed.length === 0) break
    text = trimmed
  }
  return text
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
  // scoring, so truncating here would hide real violations). Exception:
  // trailing-punctuation rescue (classifyLines.fit) for small overshoots —
  // cosmetic tail bytes are the #1 real-world over-limit cause and carry no
  // content, so stripping them cannot hide a violation.
  const rescue = (line: string, cap: number) => (countBytes(line) > cap ? fitTrailingPunctuation(line, cap) : line)
  return {
    shorts: shorts.map((line) => rescue(line, maxBytes.short)).filter(Boolean).slice(0, COPY_CAP),
    longs: longs.map((line) => rescue(line, maxBytes.long)).filter(Boolean).slice(0, COPY_CAP)
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
