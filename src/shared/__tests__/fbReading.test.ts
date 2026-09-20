import { describe, expect, it } from 'vitest'
import type { FbAccountBalance } from '../fbBillingParser'
import {
  boardReadingRangeDates,
  buildBoardReadingUrl,
  buildFbAccountOverviewUrlForRef,
  fbReadingMatchesWindow,
  parseFbReadingDateRange,
  summarizeFbReadings,
  type FbReadingHistoryEntry,
  type FbReadingHistoryRow
} from '../fbReading'

describe('FB reading date window', () => {
  const today = new Date(2026, 8, 17)
  const balance = (act: string, amount: number): FbAccountBalance => ({
    accountId: act,
    kind: 'available',
    amount,
    currency: 'USD',
    amountText: `$${amount.toFixed(2)}`,
    label: '账户余额',
    capturedAt: '2026-09-19T02:00:00.000Z',
    sourceUrl: null
  })
  it.each([
    ['today', '2026-09-17_2026-09-18'],
    ['last3', '2026-09-14_2026-09-17'],
    ['last7', '2026-09-10_2026-09-17'],
    ['last30', '2026-08-18_2026-09-17']
  ] as const)('encodes %s with an exclusive end and no preset', (range, expected) => {
    const url = new URL(buildBoardReadingUrl('三国IOS', range, today))
    expect(url.searchParams.get('date')).toBe(expected)
    expect(url.searchParams.get('insights_date')).toBe(expected)
    expect(url.searchParams.get('columns')).toContain('impressions')
    expect(url.searchParams.get('columns')).toContain('actions:mobile_app_install')
    expect(url.searchParams.get('date')).not.toContain(',')
  })

  it('handles month/year/leap-day rollover without changing display dates', () => {
    expect(boardReadingRangeDates('last3', new Date(2024, 2, 1))).toEqual({ start: '2024-02-27', end: '2024-02-29' })
    expect(new URL(buildBoardReadingUrl('三国IOS', 'today', new Date(2026, 11, 31))).searchParams.get('date'))
      .toBe('2026-12-31_2027-01-01')
  })

  it('pins the account-overview balance URL to one ad account', () => {
    const url = new URL(
      buildFbAccountOverviewUrlForRef({ alias: '三国AND', act: '27893958520273993', businessId: '1734414010144999' })
    )
    expect(url.pathname).toContain('/adsmanager/manage/accounts')
    expect(url.searchParams.get('act')).toBe('27893958520273993')
    expect(url.searchParams.get('business_id')).toBe('1734414010144999')
  })

  it('recognizes actual custom and preset labels, including a single day', () => {
    expect(parseFbReadingDateRange('2026年9月14日 – 2026年9月16日')).toEqual({ start: '2026-09-14', end: '2026-09-16' })
    expect(parseFbReadingDateRange('过去 7 天：2026年9月10日 – 2026年9月16日')).toEqual({ start: '2026-09-10', end: '2026-09-16' })
    expect(parseFbReadingDateRange('2026年9月17日')).toEqual({ start: '2026-09-17', end: '2026-09-17' })
    for (const label of ['自 2026 年 3 月 17 日起', '2026年2月30日', '2026年9月17日 – 2026年9月14日', '过去 3 天']) {
      expect(parseFbReadingDateRange(label)).toBeNull()
    }
  })

  it('refuses another account, an off-by-one date, and mismatched history', () => {
    const expected = boardReadingRangeDates('last3', today)
    expect(fbReadingMatchesWindow({ accountId: '123456', dateRangeLabel: '2026年9月14日 – 2026年9月16日' }, '123456', expected)).toBe(true)
    expect(fbReadingMatchesWindow({ accountId: '999999', dateRangeLabel: '2026年9月14日 – 2026年9月16日' }, '123456', expected)).toBe(false)
    expect(fbReadingMatchesWindow({ accountId: '123456', dateRangeLabel: '2026年9月14日 – 2026年9月15日' }, '123456', expected)).toBe(false)
    expect(fbReadingMatchesWindow({ accountId: '123456', dateRangeLabel: '过去 30 天：2026年8月18日 – 2026年9月16日' }, '123456', expected)).toBe(false)
  })

  it('sums additive fields and recomputes ratio metrics across accounts', () => {
    const row = (overrides: Partial<FbReadingHistoryRow>): FbReadingHistoryRow => ({
      name: 'camp',
      spend: null,
      costPerResult: null,
      cpm: null,
      impressions: null,
      results: null,
      resultType: null,
      clicks: null,
      ctr: null,
      cpc: null,
      installs: null,
      ...overrides
    })
    const entry = (rows: FbReadingHistoryRow[]): FbReadingHistoryEntry => ({
      id: rows[0].name,
      capturedAt: '2026-09-19T02:00:00.000Z',
      accountId: 'a',
      accountName: null,
      dateRangeLabel: '2026年9月16日 – 2026年9月18日',
      campaignCount: rows.length,
      totalSpend: null,
      rows
    })
    const ios = {
      alias: '三国IOS',
      act: '2131017261144314',
      businessId: null
    }
    const android = { alias: '三国AND', act: '27893958520273993', businessId: null }
    const summary = summarizeFbReadings(
      [ios, android],
      {
        '2131017261144314': entry([
          row({ name: 'ios', spend: 100, impressions: 10_000, clicks: 100, installs: 50, results: 5, resultType: 'Purchases' })
        ]),
        '27893958520273993': entry([
          row({ name: 'and', spend: 200, impressions: 20_000, clicks: 150, installs: 100, results: 10, resultType: 'Purchases' })
        ])
      },
      {
        '2131017261144314': balance('2131017261144314', 120),
        '27893958520273993': balance('27893958520273993', 80)
      }
    )
    expect(summary.complete).toBe(true)
    expect(summary.spend).toBe(300)
    expect(summary.installs).toBe(150)
    expect(summary.impressions).toBe(30_000)
    expect(summary.clicks).toBe(250)
    expect(summary.cpi).toBe(2)
    expect(summary.cpm).toBe(10)
    expect(summary.ctr).toBeCloseTo(0.833333, 5)
    expect(summary.cpa).toBe(20)
    expect(summary.balance).toBe(200)
    expect(summary.balanceKind).toBe('available')
    expect(summary.balanceCurrency).toBe('USD')
  })

  it('hides ratio denominators when a required column or account is missing', () => {
    const row: FbReadingHistoryRow = {
      name: 'camp',
      spend: 100,
      costPerResult: null,
      cpm: null,
      impressions: null,
      results: 5,
      resultType: 'Purchases',
      clicks: null,
      ctr: null,
      cpc: null,
      installs: null
    }
    const ref = { alias: '三国IOS', act: '2131017261144314', businessId: null }
    const entry: FbReadingHistoryEntry = {
      id: 'one',
      capturedAt: '2026-09-19T02:00:00.000Z',
      accountId: ref.act,
      accountName: null,
      dateRangeLabel: '2026年9月16日 – 2026年9月18日',
      campaignCount: 1,
      totalSpend: 100,
      rows: [row]
    }
    const summary = summarizeFbReadings(
      [ref, { alias: '三国AND', act: '27893958520273993', businessId: null }],
      { [ref.act]: entry },
      {
        '2131017261144314': balance('2131017261144314', 25),
        '27893958520273993': balance('27893958520273993', 75)
      }
    )
    expect(summary.complete).toBe(false)
    expect(summary.verifiedCount).toBe(1)
    expect(summary.spend).toBe(100)
    expect(summary.cpi).toBeNull()
    expect(summary.cpm).toBeNull()
    expect(summary.ctr).toBeNull()
    expect(summary.balance).toBe(100)
    expect(summary.accounts.find((account) => account.act === '27893958520273993')?.balance).toBe(75)
  })
})
