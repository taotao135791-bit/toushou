import { describe, expect, it } from 'vitest'
import { anonymousReadingDraft, snapshotToday } from './todaySnapshot'
import { validateReadingSnapshot } from '@shared/readingSnapshot'
import type { TodayFacebookRow } from './todayFacebook'
import type { TikTokTodayReading } from '@shared/todayReading'

const window = { start: '2026-10-01', end: '2026-10-07' }
const facebook: TodayFacebookRow = { account: { id: 'local', act: '123456789', alias: 'PRIVATE_FB_NAME', businessId: null, createdAt: 1 }, covered: true, readError: null, spend: 100, previousSpend: null, currency: null, impressions: 10, clicks: 2, conversions: null, resultType: null, costPerResult: null, capturedAt: '2026-10-08T00:00:00Z', movers: [] }
const tiktok: TikTokTodayReading = { range: 'last7', window, previousWindow: { start: '2026-09-24', end: '2026-09-30' }, generatedAt: 1000, source: 'oauth', truncated: false, accounts: [
  { advertiserId: '7777777777777777777', name: 'PRIVATE_TT_NAME', currency: 'USD', timezone: 'Etc/UTC', spend: 200, previousSpend: 100, impressions: 1000, clicks: 20, conversions: 3, campaigns: [] },
  { advertiserId: '8888888888888888888', name: 'PRIVATE_FAILED', currency: 'USD', error: 'api', detail: 'account-batch-not-attempted' }
] }

describe('saved reading scope and analysis drafts', () => {
  it('keeps failed/unknown readings explicit and preserves each account window', () => {
    const snapshot = snapshotToday({ rangeLabel: 'last week', window, capturedAt: 2000, facebook: [facebook], tiktok, facebookFailures: { '123456789': 'network' } })
    expect(validateReadingSnapshot(snapshot)).not.toBeNull()
    expect(snapshot.accounts[0]).toMatchObject({ status: 'failed', spend: null, conversions: null })
    expect(snapshot.accounts[1]).toMatchObject({ status: 'ok', spend: 200, window })
    expect(snapshot.accounts[2]).toMatchObject({ status: 'unattempted', spend: null, sourceAt: null })
  })
  it('keeps real names only in local mapping, never in the copyable analysis', () => {
    const snapshot = snapshotToday({ rangeLabel: 'last week', window, capturedAt: 2000, facebook: [facebook], tiktok })
    const draft = anonymousReadingDraft(snapshot, 'zh')
    expect(draft.text).not.toMatch(/PRIVATE_|7777777777777777777|8888888888888888888|123456789/)
    expect(draft.text).toContain('币种未知')
    expect(draft.mappings.join()).toContain('PRIVATE_TT_NAME')
    expect(draft.text).toContain('不调用工具')
  })
})
