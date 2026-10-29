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
    expect(financialComplianceViolations('实时到账，秒到账')).toHaveLength(1)
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

  it('keeps rejected reasons from scoring (W:700-705)', () => {
    const over = { ...item('x'.repeat(26), 8), bytes: 26, accepted: false, rejectReason: 'over_limit' as const }
    const { selected, rejected } = selectTopN([over, item('ok copy', 7)], 'short', 2)
    expect(selected).toHaveLength(2)
    expect(rejected).toHaveLength(0)
    const only = selectTopN([over], 'short', 1)
    expect(only.selected[0].rejectReason).toBe('over_limit')
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
