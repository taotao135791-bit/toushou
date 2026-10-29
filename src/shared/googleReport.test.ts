import { describe, expect, it } from 'vitest'
import { parseGoogleReportCsv } from './googleReport'

const header = 'Customer ID,Account name,Currency code,Campaign,Cost,Impr.,Clicks,Conversions,Conv. value'
const row = '123-456-7890,Demo,USD,Search,"1,234.50",1000,75,3.5,25'
const english = `Campaign report\nOct 1, 2026 - Oct 7, 2026\n${header}\n${row}\n`
describe('Google Ads CSV', () => {
  it('accepts a Google Ads report with a title and date preamble, no total row', () => {
    const result = parseGoogleReportCsv(english)
    expect(result.verification.verified).toBe(true)
    expect(result.summary).toMatchObject({ windowStart: '2026-10-01', windowEnd: '2026-10-07', accounts: [{ accountId: '1234567890', currency: 'USD', spend: 1234.5, impressions: 1000, clicks: 75, conversions: 3.5, conversionValue: 25 }] })
  })
  it('accepts Chinese columns and skips the platform total row', () => {
    const result = parseGoogleReportCsv('2026年10月1日 - 2026年10月7日\n客户 ID,账户名称,货币代码,广告系列,费用,展示次数,点击次数,转化次数\n123-456-7890,演示,CNY,搜索,10,100,5,2\n,,,总计：所有广告系列,10,100,5,2\n')
    expect(result.verification.verified).toBe(true)
    expect(result.summary?.accounts[0].spend).toBe(10)
  })
  it.each([
    [english.replace('Customer ID', 'Customer'), 'missing-account-or-currency'],
    [english.replace('Currency code', 'Unspecified'), 'missing-account-or-currency'],
    [english.replace('Oct 1, 2026 - Oct 7, 2026\n', ''), 'missing-date-range'],
    [english.replace('USD', '???'), 'invalid-account-or-currency'],
    [english.replace('1,234.50', '???'), 'invalid-spend'],
    [`${english}${row}\n`, 'duplicate-campaign-row']
  ])('fails closed for malformed or incomplete evidence', (input, reason) => {
    expect(parseGoogleReportCsv(input).verification).toMatchObject({ verified: false, errors: [reason] })
  })
  it('keeps absent optional metrics unknown rather than zero', () => {
    const result = parseGoogleReportCsv('2026-10-01 - 2026-10-07\nCustomer ID,Currency,Campaign,Cost\n123-456-7890,USD,Search,5')
    expect(result.summary?.accounts[0]).toMatchObject({ impressions: null, clicks: null, conversions: null, conversionValue: null })
  })
})

describe('Google activity export context', () => {
  const context = { accountId: '1234567890', accountName: 'Demo', currency: 'USD', timezone: 'GMT+00', windowStart: '2026-10-29', windowEnd: '2026-10-29' }
  it('uses verified context for ordinary activity CSV and preserves non-additive fields', () => {
    const csv = 'Campaign,Cost,Clicks,CTR\nSearch,US$9.00,3,4%\nTotal: Campaigns,US$9.00,3,4%\nTotal: All campaigns,US$9.00,3,4%'
    const result = parseGoogleReportCsv(csv, context)
    expect(result.summary?.accounts[0]).toMatchObject({ accountId: '1234567890', spend: 9, campaigns: [{ customFields: { CTR: ['4%'] } }] })
    expect(result.verification.warnings).toContain('report-scope-only')
  })
  it('rejects conflicting CSV identity and report dates', () => {
    const csv = 'Customer ID,Currency,Campaign,Cost\n999-999-9999,USD,Search,9'
    expect(parseGoogleReportCsv(csv, context).verification.errors).toEqual(['conflicting-account-or-currency'])
    expect(parseGoogleReportCsv('2026-10-28 - 2026-10-28\nCampaign,Cost\nSearch,9', context).verification.errors).toEqual(['conflicting-date-range'])
  })
})

describe('visible date and report totals', () => {
  const context = { accountId: '1234567890', accountName: 'Demo', currency: 'USD', timezone: 'GMT+00', windowStart: '2026-10-29', windowEnd: '2026-10-29' }
  it('accepts only explicit date selector labels with the known comparison suffix', async () => {
    const { parseGoogleVisibleDateRange } = await import('./googleReport')
    expect(parseGoogleVisibleDateRange('2026年10月29日 不适用')).toEqual({ start: '2026-10-29', end: '2026-10-29' })
    expect(parseGoogleVisibleDateRange('2026-10-29 Not applicable')).toEqual({ start: '2026-10-29', end: '2026-10-29' })
    expect(parseGoogleVisibleDateRange('other text 2026年10月29日 不适用')).toBeNull()
  })
  it('cross-checks current-view totals but ignores other-scope totals', () => {
    const rows = 'Campaign,Cost,Clicks\nA,9,3\nB,5,2\n'
    expect(parseGoogleReportCsv(rows + 'Total: Campaigns,14,5\nTotal: Account,800,200', context).verification.verified).toBe(true)
    expect(parseGoogleReportCsv(rows + '总计：当前视图,14,9', context).verification.errors).toEqual(['view-total-mismatch'])
    expect(parseGoogleReportCsv(rows + 'Total: Campaigns,99,5', context).verification.errors).toEqual(['view-total-mismatch'])
    expect(parseGoogleReportCsv(rows + 'Total: Account,800,200', context).verification.verified).toBe(true)
  })
})
