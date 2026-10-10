import { describe, expect, it } from 'vitest'
import { FB_REPORT_CONTRACT_VERSION, parseFbReportCsv } from '../fbReportCsv'

// Synthetic data only — real exports never enter source control (AGENTS).
const cell = (value: string | number): string =>
  /[",\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value)
const toCsv = (rows: Array<Array<string | number>>): string => rows.map((row) => row.map(cell).join(',')).join('\n')

const ZH_HEADER = [
  '账户名称', '单日', '广告名称', '覆盖人数', '展示次数', '频次', '货币', '已花费金额 (USD)',
  '归因设置', 'CPM（千次展示费用）', '点击率（全部）', '应用安装量', '单次应用安装费用', '应用内购物',
  '报告开始日期', '报告结束日期'
]

const zhTotals = (): Array<string | number> => [
  '', '', '', 15389, 24571, 1.5967, 'USD', 224.86, '', 9.15, 1.38, 16, 14.05, 2, '2026-10-07', '2026-10-07'
]
const zhDetail = (
  account: string,
  ad: string,
  reach: number,
  impressions: number,
  spend: number,
  installs: number,
  purchases: number
): Array<string | number> => [
  account, '2026-10-07', ad, reach, impressions, 1.5, 'USD', spend, '点击后 7 天内', 9.15, 1.38, installs,
  spend / Math.max(installs, 1), purchases, '2026-10-07', '2026-10-07'
]

const zhFixture = (): string =>
  toCsv([
    ZH_HEADER,
    zhTotals(),
    zhDetail('测试账户A', '素材,带逗号', 4000, 6000, 100.86, 10, 1),
    zhDetail('测试账户B', 'video-two', 11389, 18571, 124.0, 6, 1)
  ])

describe('parseFbReportCsv', () => {
  it('verifies a well-formed zh export end to end', () => {
    const outcome = parseFbReportCsv(zhFixture())
    expect(outcome.ok).toBe(true)
    expect(outcome.verification.verified).toBe(true)
    expect(outcome.verification.fatal).toEqual([])
    expect(outcome.detailRows).toBe(2)
    expect(outcome.subtotalRows).toBe(0)
    expect(outcome.mapping.language).toBe('zh')
    expect(outcome.summary?.windowStart).toBe('2026-10-07')
    expect(outcome.summary?.windowEnd).toBe('2026-10-07')
    expect(outcome.summary?.currency).toBe('USD')
    expect(outcome.summary?.attribution).toBe('点击后 7 天内')
    expect(outcome.summary?.days).toEqual(['2026-10-07'])
    expect(outcome.summary?.totals.spend).toBe(224.86)
    expect(outcome.summary?.totals.installs).toBe(16)
    expect(outcome.summary?.accounts).toHaveLength(2)
    const b = outcome.summary?.accounts[0] // sorted by spend desc
    expect(b?.account).toBe('测试账户B')
    expect(b?.spend).toBe(124)
    expect(b?.impressions).toBe(18571)
    expect(b?.installs).toBe(6)
    expect(b?.purchases).toBe(1)
    expect(b?.cpi).toBeCloseTo(124 / 6, 5)
    expect(b?.cpm).toBeCloseTo((124 / 18571) * 1000, 3)
    expect(b?.clicks).toBeNull() // no clicks column in this fixture
  })

  it('keeps verified=true with a warning when a volume metric is off by one', () => {
    const rows = [
      ZH_HEADER,
      ['', '', '', 15389, 24571, 1.5967, 'USD', 224.86, '', 9.15, 1.38, 16, 14.05, 2, '2026-10-07', '2026-10-07'],
      zhDetail('测试账户A', 'ad-a', 4000, 6000, 100.86, 10, 1),
      zhDetail('测试账户B', 'ad-b', 11389, 18570, 124.0, 6, 1)
    ]
    const outcome = parseFbReportCsv(toCsv(rows))
    expect(outcome.verification.verified).toBe(true)
    expect(outcome.verification.warnings).toHaveLength(1)
    expect(outcome.verification.warnings[0].code).toBe('sum-diff')
    expect(outcome.verification.warnings[0].column).toContain('展示次数')
  })

  it('rejects when spend sums disagree with the FB totals row', () => {
    const rows = [
      ZH_HEADER,
      ['', '', '', 15389, 24571, 1.5967, 'USD', 999.0, '', 9.15, 1.38, 16, 14.05, 2, '2026-10-07', '2026-10-07'],
      zhDetail('测试账户A', 'ad-a', 4000, 6000, 100.86, 10, 1),
      zhDetail('测试账户B', 'ad-b', 11389, 18571, 124.0, 6, 1)
    ]
    const outcome = parseFbReportCsv(toCsv(rows))
    expect(outcome.verification.verified).toBe(false)
    expect(outcome.verification.fatal[0].code).toBe('sum-mismatch')
    expect(outcome.verification.fatal[0].column).toContain('已花费金额')
  })

  it('rejects a file without a totals row', () => {
    const rows = [ZH_HEADER, zhDetail('测试账户A', 'ad-a', 4000, 6000, 100.86, 10, 1)]
    const outcome = parseFbReportCsv(toCsv(rows))
    expect(outcome.verification.verified).toBe(false)
    expect(outcome.verification.fatal.map((f) => f.code)).toContain('missing-totals-row')
  })

  it('rejects when the spend column is missing entirely', () => {
    const header = ZH_HEADER.filter((h) => !h.includes('已花费金额'))
    const outcome = parseFbReportCsv(toCsv([header, ['', '', '', 15389, 24571, 1.6, 'USD', '', 9.15, 1.38, 16, 14.05, 2, '2026-10-07', '2026-10-07']]))
    expect(outcome.verification.verified).toBe(false)
    expect(outcome.verification.fatal[0].code).toBe('missing-spend-column')
  })

  it('excludes subtotal rows from reconciliation', () => {
    const rows = [
      ZH_HEADER,
      zhTotals(),
      // Subtotal: account filled, day + ad empty — must not enter sums.
      ['测试账户A', '', '', 4000, 6000, 1.5, 'USD', 100.86, '', 9.15, 1.38, 10, 10.086, 1, '2026-10-07', '2026-10-07'],
      zhDetail('测试账户A', 'ad-a', 4000, 6000, 100.86, 10, 1),
      zhDetail('测试账户B', 'ad-b', 11389, 18571, 124.0, 6, 1)
    ]
    const outcome = parseFbReportCsv(toCsv(rows))
    expect(outcome.verification.verified).toBe(true)
    expect(outcome.detailRows).toBe(2)
    expect(outcome.subtotalRows).toBe(1)
  })

  it('strips a BOM and survives quoted commas', () => {
    const outcome = parseFbReportCsv('\uFEFF' + zhFixture())
    expect(outcome.verification.verified).toBe(true)
    const a = outcome.summary?.accounts.find((row) => row.account === '测试账户A')
    expect(a?.spend).toBe(100.86)
  })

  it('maps English headers through the same contract', () => {
    const enHeader = [
      'Account name', 'Day', 'Ad name', 'Reach', 'Impressions', 'Frequency', 'Currency', 'Amount spent (USD)',
      'Attribution setting', 'CPM (cost per 1,000 impressions)', 'CTR (all)', 'App installs',
      'Cost per app install', 'In-app purchases', 'Reporting start date', 'Reporting end date'
    ]
    const detail = (account: string, ad: string, impressions: number, spend: number, installs: number): Array<string | number> =>
      [account, '2026-10-07', ad, 4000, impressions, 1.5, 'USD', spend, '7-day click', 9.15, 1.38, installs, spend / Math.max(installs, 1), 1, '2026-10-07', '2026-10-07']
    const csv = toCsv([
      enHeader,
      ['', '', '', 15389, 24571, 1.6, 'USD', 224.86, '', 9.15, 1.38, 16, 14.05, 2, '2026-10-07', '2026-10-07'],
      detail('Account-A', 'ad-a', 6000, 100.86, 10),
      detail('Account-B', 'ad-b', 18571, 124.0, 6)
    ])
    const outcome = parseFbReportCsv(csv)
    expect(outcome.verification.verified).toBe(true)
    expect(outcome.mapping.language).toBe('en')
    expect(outcome.summary?.accounts).toHaveLength(2)
    expect(FB_REPORT_CONTRACT_VERSION).toBe(1)
  })

  it('rejects inconsistent report windows', () => {
    const rows = [
      ZH_HEADER,
      zhTotals(),
      zhDetail('测试账户A', 'ad-a', 4000, 6000, 100.86, 10, 1),
      ['测试账户B', '2026-10-07', 'ad-b', 11389, 18571, 1.5, 'USD', 124.0, '点击后 7 天内', 9.15, 1.38, 6, 20.67, 1, '2026-10-07', '2026-10-08']
    ]
    const outcome = parseFbReportCsv(toCsv(rows))
    expect(outcome.verification.verified).toBe(false)
    expect(outcome.verification.fatal.map((f) => f.code)).toContain('window-inconsistent')
  })

  it('accepts multi-day exports where detail rows carry per-day windows', () => {
    const rows = [
      ZH_HEADER,
      // Totals: the 14-day export window.
      ['', '', '', 15389, 24571, 1.5967, 'USD', 224.86, '', 9.15, 1.38, 16, 14.05, 2, '2026-09-26', '2026-10-09'],
      // Detail rows: each carries its OWN day in the window columns.
      ['测试账户A', '2026-09-26', 'ad-a', 4000, 6000, 1.5, 'USD', 100.43, '点击后 7 天内', 9.15, 1.38, 5, 20.086, 1, '2026-09-26', '2026-09-26'],
      ['测试账户B', '2026-10-09', 'ad-b', 11389, 18571, 1.5, 'USD', 124.43, '点击后 7 天内', 9.15, 1.38, 11, 11.312, 1, '2026-10-09', '2026-10-09']
    ]
    const outcome = parseFbReportCsv(toCsv(rows))
    expect(outcome.verification.verified).toBe(true)
    expect(outcome.summary?.windowStart).toBe('2026-09-26')
    expect(outcome.summary?.windowEnd).toBe('2026-10-09')
    expect(outcome.summary?.days).toEqual(['2026-09-26', '2026-10-09'])
  })

  it('aggregates unknown metric columns — finance report without installs', () => {
    const header = ['账户名称', '单日', '广告名称', '货币', '花费金额 (USD)', '展示次数', '首次充值金额', '购买次数', '报告开始日期', '报告结束日期']
    const detail = (account: string, ad: string, spend: number, imp: number, firstDeposit: number, purchases: number): Array<string | number> =>
      [account, '2026-10-07', ad, 'USD', spend, imp, firstDeposit, purchases, '2026-10-07', '2026-10-07']
    const csv = toCsv([
      header,
      ['', '', '', 'USD', 224.86, 24571, 96.50, 42, '2026-10-07', '2026-10-07'],
      detail('金融账户A', 'ad-a', 100.86, 6000, 46.50, 21),
      detail('金融账户B', 'ad-b', 124.00, 18571, 50.00, 21)
    ])
    const outcome = parseFbReportCsv(csv)
    expect(outcome.verification.verified).toBe(true)
    // Open metric model: every numeric column is present, in file order.
    const headers = outcome.summary?.metrics.map((m) => m.header)
    expect(headers).toEqual(['花费金额 (USD)', '展示次数', '首次充值金额', '购买次数'])
    const kinds = outcome.summary?.metrics.map((m) => m.kind)
    expect(kinds).toEqual(['money', 'count', 'money', 'count'])
    // Unknown money column reconciled against the totals row.
    expect(outcome.verification.fatal).toEqual([])
    // Per-account open metrics: sums for money/count columns.
    const a = outcome.summary?.accounts.find((row) => row.account === '金融账户A')
    expect(a?.metrics['首次充值金额']).toBe(46.5)
    expect(a?.metrics['购买次数']).toBe(21)
    expect(a?.metrics['花费金额 (USD)']).toBe(100.86)
    // FB totals per header.
    expect(outcome.summary?.totalsByHeader['首次充值金额']).toBe(96.5)
    // No installs column in this file — canonical installs is null.
    expect(a?.installs).toBeNull()
  })
})
