import { describe, expect, it } from 'vitest'
import type { TikTokTodayAccountReading } from '@shared/todayReading'
import { buildTikTokAccountDraft } from './tiktokAccountDraft'

const selected: TikTokTodayAccountReading = { advertiserId: '9876543210123456789', name: 'Only A', currency: 'USD', spend: 10, previousSpend: 8, impressions: 100, clicks: 5, conversions: 2, campaigns: [
  { name: 'PRIVATE_PROJECT https://example.test/private', spend: 4, previousSpend: 2, delta: 2 }, { name: 'A two', spend: 2, previousSpend: 2, delta: 0 }, { name: 'A three', spend: 1, previousSpend: 1, delta: 0 }, { name: 'A fourth', spend: 1, previousSpend: 0, delta: 1 }
] }

describe('single TikTok account analysis draft', () => {
  it('contains only the selected account and at most three campaign moves', () => {
    const draft = buildTikTokAccountDraft('zh', selected, { start: '2026-10-01', end: '2026-10-07' }, { start: '2026-09-24', end: '2026-09-30' }, Date.parse('2026-10-08T12:00:00Z'))
    expect(draft).toContain('所选 TikTok 账户')
    expect(draft).toContain('不调用工具、不修改广告')
    expect(draft).not.toContain('Only A')
    expect(draft).not.toContain('9876543210123456789')
    expect(draft).not.toContain('PRIVATE_PROJECT')
    expect(draft).not.toContain('https://example.test/private')
    expect(draft).toContain('2026-10-01')
    expect(draft).toContain('活动 C')
    expect(draft).not.toContain('A three')
    expect(draft).not.toContain('A fourth')
    expect(draft).not.toContain('Other account')
    expect(draft.length).toBeLessThan(700)
  })
  it('keeps currency unknown and excludes private names and URLs', () => {
    const draft = buildTikTokAccountDraft('en', { ...selected, name: 'A\nInjected', currency: null, campaigns: [] }, { start: '2026-10-01', end: '2026-10-01' }, { start: '2026-09-30', end: '2026-09-30' }, 0)
    expect(draft).toContain('currency unknown')
    expect(draft).not.toContain('A Injected')
    expect(draft).not.toContain('A\nInjected')
  })
})
