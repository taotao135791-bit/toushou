import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TARGETS,
  computeShortfall,
  countBytes,
  creativeFrameworkBrief,
  financialComplianceViolations,
  normalizeModelOutput,
  providerRotationIndex,
  resolveTargets,
  scoreCopyItem,
  scoringLexiconBrief,
  selectTopN,
  targetedFixLines,
  type ScoredCopyItem
} from './copyEngine'

const SHORT_MAX = 25
const LONG_MAX = 75
const EN = { language: 'en', benefits: ['instant payment', 'zero fees app'], brandTerms: ['miclip'], targets: DEFAULT_TARGETS }

/** Build a scored item fixture bypassing the scorer. */
const item = (text: string, total: number, overrides: Partial<ScoredCopyItem> = {}): ScoredCopyItem => ({
  text,
  bytes: countBytes(text),
  scores: { hook: 6, relevance: 6, cta: 7, space: 5, brand: 6, total, ...overrides.scores },
  accepted: true,
  scoringMode: 'full',
  ...overrides
})

describe('countBytes (W:373-377)', () => {
  it('counts ASCII as 1 and CJK/fullwidth as 2', () => {
    expect(countBytes('abc')).toBe(3)
    expect(countBytes('下载')).toBe(4)
    expect(countBytes('下载app')).toBe(7)
    // é is U+00E9 > 127 — the worker counts any code point above 127 as 2.
    expect(countBytes('café')).toBe(5)
  })
})

describe('scoreCopyItem', () => {
  it('hook: word in first third +6, digit in first half +2, question +2, capped 10', () => {
    const plain = scoreCopyItem('Transfer money to friends easily', { ...EN, type: 'long', maxBytes: LONG_MAX })
    expect(plain.scores.hook).toBe(0)
    const hooked = scoreCopyItem('Discover a faster way to pay friends', { ...EN, type: 'long', maxBytes: LONG_MAX })
    expect(hooked.scores.hook).toBe(6)
    const hookDigit = scoreCopyItem('Discover 3 ways to pay friends abroad', { ...EN, type: 'long', maxBytes: LONG_MAX })
    expect(hookDigit.scores.hook).toBe(8)
    const all = scoreCopyItem('Discover 3 ways? Pay friends abroad now', { ...EN, type: 'long', maxBytes: LONG_MAX })
    expect(all.scores.hook).toBe(10)
  })

  it('relevance: 0/1/3/5 benefit hits map to 2/6/8/10', () => {
    const none = scoreCopyItem('Transfer money to friends today', { ...EN, type: 'long', maxBytes: LONG_MAX })
    expect(none.scores.relevance).toBe(2)
    const one = scoreCopyItem('Instant payment for everyone', { ...EN, type: 'long', maxBytes: LONG_MAX })
    expect(one.scores.relevance).toBe(6)
  })

  it('cta: lexicon verb scores 10; otherwise short 4 / long 2', () => {
    const withCta = scoreCopyItem('miclip instant payment — download today', { ...EN, type: 'short', maxBytes: SHORT_MAX })
    expect(withCta.scores.cta).toBe(10)
    const noCta = scoreCopyItem('miclip instant payment for teams', { ...EN, type: 'short', maxBytes: SHORT_MAX })
    expect(noCta.scores.cta).toBe(4)
    const noCtaLong = scoreCopyItem('miclip instant payment for teams and their families everywhere', { ...EN, type: 'long', maxBytes: LONG_MAX })
    expect(noCtaLong.scores.cta).toBe(2)
  })

  it('space: bands 75/55/35 percent and zero when over the limit', () => {
    const over = scoreCopyItem('x'.repeat(26), { ...EN, type: 'short', maxBytes: SHORT_MAX })
    expect(over.scores.space).toBe(0)
    expect(over.accepted).toBe(false)
    expect(over.rejectReason).toBe('over_limit')
    const near = scoreCopyItem('x'.repeat(20), { ...EN, type: 'short', maxBytes: SHORT_MAX })
    expect(near.scores.space).toBe(10)
    const mid = scoreCopyItem('x'.repeat(15), { ...EN, type: 'short', maxBytes: SHORT_MAX })
    expect(mid.scores.space).toBe(7)
    const low = scoreCopyItem('x'.repeat(10), { ...EN, type: 'short', maxBytes: SHORT_MAX })
    expect(low.scores.space).toBe(4)
  })

  it('brand: base 4 + brand/benefit hits, minus forbidden×2, clamped 0-10', () => {
    const withBrand = scoreCopyItem('miclip instant payment today', { ...EN, type: 'short', maxBytes: SHORT_MAX })
    const bare = scoreCopyItem('pay friends today', { ...EN, type: 'short', maxBytes: SHORT_MAX })
    expect(withBrand.scores.brand).toBeGreaterThan(bare.scores.brand)
    const zhForbidden = scoreCopyItem('保证省钱又稳赚的支付app', { ...EN, language: 'zh-CN', type: 'long', maxBytes: LONG_MAX })
    expect(zhForbidden.scores.brand).toBeLessThanOrEqual(2)
    expect(zhForbidden.accepted).toBe(false)
  })

  it('total is the 0.22/0.34/0.18/0.10/0.16 weighted round', () => {
    const scored = scoreCopyItem('Discover 2 ways to send instant payment with miclip now', { ...EN, type: 'long', maxBytes: LONG_MAX })
    const s = scored.scores
    expect(scored.scores.total).toBe(Math.round(s.hook * 0.22 + s.relevance * 0.34 + s.cta * 0.18 + s.space * 0.1 + s.brand * 0.16))
  })

  it('accept rule needs bytes + compliance + every floor (W:472-475)', () => {
    const strict = { ...DEFAULT_TARGETS, hook: 10, relevance: 10, cta: 10, space: 10, total: 10 }
    const scored = scoreCopyItem('Discover 2 ways to send instant payment with miclip now', { ...EN, type: 'long', maxBytes: LONG_MAX, targets: strict })
    expect(scored.accepted).toBe(false)
    expect(scored.rejectReason).toBe('below_score_targets')
  })

  it('caller targets override the defaults and clamp to 0-10', () => {
    expect(resolveTargets({ hook: 9, total: 3 })).toEqual({ hook: 9, relevance: 6, cta: 7, space: 5, total: 3 })
    expect(resolveTargets({ hook: 99, cta: -1 })).toEqual({ hook: 10, relevance: 6, cta: 0, space: 5, total: 7 })
    expect(resolveTargets({})).toEqual(DEFAULT_TARGETS)
  })

  it('uses the zh-CN lexicon for Chinese copy (W:383)', () => {
    const zh = scoreCopyItem('发现更好用的支付方式，立即下载体验', { language: 'zh-CN', benefits: ['支付'], brandTerms: ['miclip'], targets: DEFAULT_TARGETS, type: 'long', maxBytes: LONG_MAX })
    expect(zh.scores.hook).toBeGreaterThanOrEqual(6)
    expect(zh.scores.cta).toBe(10)
  })

  it('accented lexicon entries normalize (fr, W:443-451)', () => {
    const fr = scoreCopyItem('Découvrez le paiement simple pour tous les jours', { language: 'fr', benefits: [], brandTerms: [], targets: DEFAULT_TARGETS, type: 'long', maxBytes: LONG_MAX })
    expect(fr.scores.hook).toBeGreaterThanOrEqual(6)
  })
})

describe('financialComplianceViolations (W:478-486)', () => {
  it('flags EN and ZH claims and passes clean copy', () => {
    // Three hits: EN pattern 0 (bank-grade), EN pattern 4 (guaranteed
    // approval) AND the ZH pattern — W:485 literally embeds ' guaranteed
    // approval' with a leading space, so it fires on the same phrase.
    expect(financialComplianceViolations('Bank-grade security, guaranteed approval')).toHaveLength(3)
    // Every occurrence counts now (per-match exemption must see them all).
    expect(financialComplianceViolations('实时到账，秒到账')).toHaveLength(2)
    expect(financialComplianceViolations('Send money to friends')).toHaveLength(0)
  })
})

describe('selectTopN (W:662-705)', () => {
  it('dedupes by type::lower(text)', () => {
    const { selected, rejected } = selectTopN([item('Download now', 9), item('download NOW', 8), item('Try it free', 7)], 'short', 3)
    expect(selected.map((i) => i.text)).toEqual(['Download now', 'Try it free'])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].rejectReason).toBe('not_needed')
  })

  it('fills to qty by sort value and replaces the worst when a better one arrives', () => {
    const { selected } = selectTopN([item('A', 5), item('B', 7), item('C', 9)], 'short', 2)
    expect(selected.map((i) => i.text)).toEqual(['C', 'B'])
    const replaced = selectTopN([item('A', 5), item('B', 7), item('C', 9), item('D', 6)], 'short', 2)
    expect(replaced.selected.map((i) => i.text).sort()).toEqual(['B', 'C'])
  })

  it('keeps rejected reasons from scoring and never selects a rejected line', () => {
    const over = { ...item('x'.repeat(26), 8), bytes: 26, accepted: false, rejectReason: 'over_limit' as const }
    const { selected, rejected } = selectTopN([over, item('ok copy', 7)], 'short', 2)
    // Quota is NOT padded with the over-limit line: only accepted copy ships.
    expect(selected).toHaveLength(1)
    expect(selected[0].text).toBe('ok copy')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].rejectReason).toBe('over_limit')
    const only = selectTopN([over], 'short', 1)
    expect(only.selected).toHaveLength(0)
    expect(only.rejected[0].rejectReason).toBe('over_limit')
  })
})

describe('normalizeModelOutput (W:525-632)', () => {
  it('parses fenced JSON with think-block preamble', () => {
    const raw = '<think>reasoning here</think>\n```json\n{"short": ["Download now"], "long": ["Send money to friends instantly"]}\n```'
    expect(normalizeModelOutput(raw, { short: SHORT_MAX, long: LONG_MAX })).toEqual({
      shorts: ['Download now'],
      longs: ['Send money to friends instantly']
    })
  })

  it('extracts the first brace-matched object from prose', () => {
    const raw = 'Sure! Here you go: {"headlines": ["Discover pay"], "descriptions": ["A simpler way to pay friends every single day"]} hope that helps'
    expect(normalizeModelOutput(raw, { short: SHORT_MAX, long: LONG_MAX })).toEqual({
      shorts: ['Discover pay'],
      longs: ['A simpler way to pay friends every single day']
    })
  })

  it('unwraps nested data/result containers and item objects (W:572-578)', () => {
    const raw = JSON.stringify({ result: { items: [{ text: 'Download now' }, { copy: 'A simpler way to pay friends today and always' }] } })
    const parsed = normalizeModelOutput(raw, { short: SHORT_MAX, long: LONG_MAX })
    expect(parsed.shorts).toEqual(['Download now'])
    expect(parsed.longs).toEqual(['A simpler way to pay friends today and always'])
  })

  it('falls back to plain lines classified by byte length with label/bullet cleanup (W:609-628)', () => {
    const raw = '好的\n1. Download now\n- Send money to friends instantly\nshort:\n[skipped]'
    const parsed = normalizeModelOutput(raw, { short: SHORT_MAX, long: LONG_MAX })
    expect(parsed.shorts).toContain('Download now')
    expect(parsed.longs).toContain('Send money to friends instantly')
    expect(parsed.shorts).not.toContain('好的')
  })

  it('caps arrays at 50 and never throws on garbage', () => {
    const many = JSON.stringify({ short: Array.from({ length: 80 }, (_, i) => `line ${i}`) })
    expect(normalizeModelOutput(many, { short: SHORT_MAX, long: LONG_MAX }).shorts).toHaveLength(50)
    // W:620's line filter drops any line containing }/[ etc.; brace-only
    // garbage therefore normalizes to empty arrays (the worker throws here —
    // the port returns empties by contract).
    expect(normalizeModelOutput('}}} {{{', { short: SHORT_MAX, long: LONG_MAX })).toEqual({ shorts: [], longs: [] })
  })
})

describe('retry helpers (W:759-822, 893-936)', () => {
  it('computeShortfall: max of per-type remaining, floor 1', () => {
    expect(computeShortfall(0, 0, [{ type: 'short', qty: 5 }])).toBe(5)
    expect(computeShortfall(3, 0, [{ type: 'short', qty: 5 }, { type: 'long', qty: 5 }])).toBe(5)
    expect(computeShortfall(4, 0, [{ type: 'short', qty: 5 }, { type: 'long', qty: 5 }])).toBe(5)
    expect(computeShortfall(5, 5, [{ type: 'short', qty: 5 }])).toBe(1)
  })

  it('providerRotationIndex: round-robin with negative-safe modulo (W:924)', () => {
    expect(providerRotationIndex(3, 0, 1)).toBe(0)
    expect(providerRotationIndex(3, 0, 2)).toBe(1)
    expect(providerRotationIndex(3, 1, 1)).toBe(1)
    expect(providerRotationIndex(3, 2, 1, 2)).toBe((2 + 1 - 1 + 2) % 3)
    expect(providerRotationIndex(4, 1, -3)).toBe(((1 - 3 - 1) % 4 + 4) % 4)
    expect(providerRotationIndex(0, 1, 1)).toBe(0)
  })

  it('creativeFrameworkBrief rotates five frameworks by (attempt+categoryIndex-1) mod 5', () => {
    const briefs = new Set<string>()
    for (let attempt = 1; attempt <= 5; attempt++) briefs.add(creativeFrameworkBrief(attempt, 0))
    expect(briefs.size).toBe(5)
    expect(creativeFrameworkBrief(6, 0)).toBe(creativeFrameworkBrief(1, 0))
    expect(creativeFrameworkBrief(1, 1)).toBe(creativeFrameworkBrief(2, 0))
  })

  it('targetedFixLines: top-3 failure dimensions ranked by count, ignoring zero counts', () => {
    const lines = targetedFixLines({ over: 4, compliance: 9, hook: 1, cta: 6, space: 0, rel: 0, total: 0 })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('Remove unsupported finance claims')
    expect(lines[1]).toContain('action verb')
    expect(lines[2]).toContain('Shorten first')
    expect(targetedFixLines({})).toEqual([])
    expect(targetedFixLines({ space: 0 })).toEqual([])
  })
})

describe('scoringLexiconBrief', () => {
  it('exposes the rewarded words per language', () => {
    expect(scoringLexiconBrief('es-MX').hook).toContain('descubre')
    expect(scoringLexiconBrief('es-MX').cta).toContain('descarga')
    expect(scoringLexiconBrief('zh-CN').forbidden).toContain('保证')
    expect(scoringLexiconBrief('tl').hook).toContain('libre')
    expect(scoringLexiconBrief('pt-BR').cta).toContain('baixe')
    expect(scoringLexiconBrief('zh').hook).toContain('发现')
    // Region codes are matched case-insensitively: zh-TW must get the
    // Traditional lexicon, never the Simplified fallback.
    expect(scoringLexiconBrief('zh-TW').hook).toContain('發現')
    expect(scoringLexiconBrief('zh-tw').hook).toContain('發現')
    expect(scoringLexiconBrief('es-MX').hook).toContain('descubre')
    // A caller must not be able to mutate the scorer's own list.
    const brief = scoringLexiconBrief('en')
    brief.hook.push('mutated')
    expect(scoringLexiconBrief('en').hook).not.toContain('mutated')
  })

  it('marks unlisted languages degraded instead of steering toward English words', () => {
    const brief = scoringLexiconBrief('sw')
    expect(brief.degraded).toBe(true)
    expect(brief.hook).toEqual([])
    expect(brief.cta).toEqual([])
    // English leakage stays banned even without a native lexicon.
    expect(brief.forbidden).toContain('guaranteed')
    expect(scoringLexiconBrief('th').degraded).toBe(false)
  })
})

describe('multi-language scoring coverage', () => {
  it('accepts native Filipino copy (tl alias → fil)', () => {
    const scored = scoreCopyItem('Libreng app ngayon para sa bayad online, i-download at mag-register na', {
      language: 'tl',
      benefits: ['bayad online'],
      brandTerms: [],
      targets: DEFAULT_TARGETS,
      type: 'long',
      maxBytes: LONG_MAX
    })
    expect(scored.accepted).toBe(true)
    expect(scored.scoringMode).toBe('full')
    expect(scored.scores.cta).toBe(10)
  })

  it('accepts Thai copy and script-matches an unlisted language code', () => {
    const opts = {
      benefits: ['ฟรี'],
      brandTerms: [],
      targets: DEFAULT_TARGETS,
      type: 'short' as const,
      maxBytes: SHORT_MAX
    }
    const thai = scoreCopyItem('ฟรี โหลดเลย', { ...opts, language: 'th' })
    expect(thai.accepted).toBe(true)
    expect(thai.scoringMode).toBe('full')
    // Unknown code, Thai text: the script sniff rescues it from the English fallback.
    const sniffed = scoreCopyItem('ฟรี โหลดเลย', { ...opts, language: 'xx' })
    expect(sniffed.accepted).toBe(true)
    expect(sniffed.scoringMode).toBe('full')
  })

  it('accepts Vietnamese copy with diacritics normalized on both sides', () => {
    const scored = scoreCopyItem('Khám phá thanh toán miễn phí, tải miclip ngay và dùng thử', {
      language: 'vi',
      benefits: ['thanh toán'],
      brandTerms: ['miclip'],
      targets: DEFAULT_TARGETS,
      type: 'long',
      maxBytes: LONG_MAX
    })
    expect(scored.accepted).toBe(true)
    expect(scored.scores.relevance).toBeGreaterThanOrEqual(6)
  })

  it('accepts Japanese and Korean copy in their native scripts', () => {
    const ja = scoreCopyItem('無料で今すぐ即時送金 — ダウンロードして始めよう', {
      language: 'ja',
      benefits: ['即時送金'],
      brandTerms: [],
      targets: DEFAULT_TARGETS,
      type: 'long',
      maxBytes: LONG_MAX
    })
    expect(ja.accepted).toBe(true)
    const ko = scoreCopyItem('무료 간편한 해외 송금 — 지금 다운로드하고 시작하세요', {
      language: 'ko',
      benefits: ['간편한 해외 송금'],
      brandTerms: [],
      targets: DEFAULT_TARGETS,
      type: 'long',
      maxBytes: LONG_MAX
    })
    expect(ko.accepted).toBe(true)
  })

  it('accepts pt-BR copy via base-code resolution', () => {
    const scored = scoreCopyItem('Descubra o pagamento simples — baixe o miclip agora e comece a usar', {
      language: 'pt-BR',
      benefits: ['pagamento'],
      brandTerms: ['miclip'],
      targets: DEFAULT_TARGETS,
      type: 'long',
      maxBytes: LONG_MAX
    })
    expect(scored.accepted).toBe(true)
  })

  it('degrades unlisted languages instead of failing every line on hook/CTA floors', () => {    // Native Swahili: no English hook word, no English CTA verb — the old
    // English-fallback floors would have zeroed this exact line.
    const scored = scoreCopyItem('Malipo ya haraka kwa mtu yote — pakua programu sasa na uhifadhi', {
      language: 'sw',
      benefits: ['malipo'],
      brandTerms: [],
      targets: DEFAULT_TARGETS,
      type: 'long',
      maxBytes: LONG_MAX
    })
    expect(scored.scoringMode).toBe('degraded')
    expect(scored.accepted).toBe(true)
    expect(scored.scores.cta).toBe(2)
    // Substance gates stay hard even in degraded mode.
    const weak = scoreCopyItem('Programu yetu ni nzuri sana kwa kila mtu wetu', {
      language: 'sw',
      benefits: ['malipo'],
      brandTerms: [],
      targets: DEFAULT_TARGETS,
      type: 'long',
      maxBytes: LONG_MAX
    })
    expect(weak.accepted).toBe(false)
  })
})

describe('selectTopN compliance gate', () => {
  const item = (text: string, accepted: boolean, total: number) => ({
    text,
    bytes: text.length,
    scores: { hook: 8, relevance: 8, cta: 8, space: 8, brand: 8, total },
    accepted,
    scoringMode: 'full' as const,
    ...(accepted ? {} : { rejectReason: 'financial_compliance_violation' })
  })

  it('never fills the quota with rejected candidates', () => {
    const picked = selectTopN(
      [item('Good line', true, 8), item('Guaranteed approval', false, 9), item('Miracle returns', false, 9)],
      'short',
      3
    )
    expect(picked.selected.map((entry) => entry.text)).toEqual(['Good line'])
    expect(picked.rejected).toHaveLength(2)
  })
})

describe('compliance and byte-rescue hardening', () => {
  it('exempts financial phrases the user confirmed as product facts', () => {
    // The user's own fact sheet says "zero fees" — writing it is not a
    // fabricated claim, so it must not hard-reject the line.
    const confirmed = scoreCopyItem('Get zero fees transfers with miclip now', {
      language: 'en', benefits: ['zero fees transfers'], brandTerms: ['miclip'], targets: DEFAULT_TARGETS, type: 'long', maxBytes: LONG_MAX
    })
    expect(confirmed.rejectReason).not.toBe('financial_compliance_violation')
    // An UNCONFIRMED claim stays a hard reject — the red line is "never fabricate".
    const fabricated = scoreCopyItem('Get guaranteed approval with miclip now', {
      language: 'en', benefits: ['zero fees transfers'], brandTerms: ['miclip'], targets: DEFAULT_TARGETS, type: 'long', maxBytes: LONG_MAX
    })
    expect(fabricated.accepted).toBe(false)
    expect(fabricated.rejectReason).toBe('financial_compliance_violation')
  })

  it('exempts each confirmed fact occurrence without masking unconfirmed claims', () => {
    // "zero fees" is user-confirmed; "lowest fees" is NOT — first-match-only
    // exemption used to let the same pattern's second claim slip through.
    const scored = scoreCopyItem('Zero fees and lowest fees with miclip now', {
      language: 'en', benefits: ['zero fees'], brandTerms: ['miclip'], targets: DEFAULT_TARGETS, type: 'long', maxBytes: LONG_MAX
    })
    expect(scored.rejectReason).toBe('financial_compliance_violation')
  })

  it('rescues small byte overshoots by stripping trailing punctuation', () => {
    // 13 CJK chars = 26 bytes (over the 25 cap); dropping the trailing 。lands at 24.
    const parsed = normalizeModelOutput('{"short":["免费转账给家人超方便的啦。"],"long":[]}', { short: SHORT_MAX, long: LONG_MAX })
    expect(parsed.shorts).toEqual(['免费转账给家人超方便的啦'])
    // A genuinely too-long line is NOT trimmed into fake compliance — it
    // stays verbatim and scoring rejects it honestly with over_limit.
    const overflow = normalizeModelOutput('{"short":["这是一个特别特别特别特别特别长的标题根本塞不下"],"long":[]}', { short: SHORT_MAX, long: LONG_MAX })
    const scored = scoreCopyItem(overflow.shorts[0], { language: 'zh-CN', benefits: ['转账'], brandTerms: [], targets: DEFAULT_TARGETS, type: 'short', maxBytes: SHORT_MAX })
    expect(scored.accepted).toBe(false)
    expect(scored.rejectReason).toBe('over_limit')
  })
})
