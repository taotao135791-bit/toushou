import { describe, expect, it } from 'vitest'
import type { FbReadingHistoryEntry } from '../fbReading'
import type { FbReportStoredReading } from '../fbReportCsv'
import type { GoogleReportStoredReading } from '../googleReport'
import type { TikTokReadingSummary } from '../tiktokReport'
import {
  fbPanelReadingEvidence,
  fbReportReadingEvidence,
  googleReportReadingEvidence,
  ttMcpReadingEvidence
} from '../readingEvidence'

const fbEntry: FbReadingHistoryEntry = {
  id: 'entry-1',
  capturedAt: '2026-10-29T12:34:56.000Z',
  accountId: 'act_123',
  accountName: 'Adtiger-C1',
  dateRangeLabel: 'Sep 15, 2026 – Sep 21, 2026',
  campaignCount: 11,
  totalSpend: 1226.11,
  rows: []
}

describe('fbPanelReadingEvidence', () => {
  it('projects account, window and coverage', () => {
    const evidence = fbPanelReadingEvidence(fbEntry)
    expect(evidence.kind).toBe('panel')
    expect(evidence.auth).toBeNull()
    expect(evidence.capturedAt).toBe(Date.parse('2026-10-29T12:34:56.000Z'))
    expect(evidence.sourceDetail).toBe('Adtiger-C1 (act_123)')
    expect(evidence.scopeLabel).toBe('Sep 15, 2026 – Sep 21, 2026')
    expect(evidence.includedCount).toBe(11)
    expect(evidence.includedUnit).toBe('campaigns')
    expect(evidence.warnings).toEqual([])
  })

  it('falls back to the bare account id and null coverage', () => {
    const evidence = fbPanelReadingEvidence({
      ...fbEntry,
      accountName: null,
      campaignCount: null,
      capturedAt: 'not-a-date'
    })
    expect(evidence.sourceDetail).toBe('act_123')
    expect(evidence.capturedAt).toBeNull()
    expect(evidence.includedCount).toBeNull()
    expect(evidence.includedUnit).toBeNull()
  })
})

const fbReportStored: FbReportStoredReading = {
  widgetId: 'w1',
  importedAt: 1792700000000,
  fileName: 'report.csv',
  contractVersion: 1,
  summary: {
    windowStart: '2026-10-01',
    windowEnd: '2026-10-07',
    days: ['2026-10-01'],
    currency: 'USD',
    attribution: '7-day click',
    accounts: [{
      account: 'act_1', spend: null, impressions: null, clicks: null, installs: null,
      purchases: null, cpm: null, cpi: null, ctr: null, metrics: {}
    }],
    totals: {},
    metrics: [],
    totalsByHeader: {}
  },
  warnings: [
    { code: 'sum-diff', column: 'Amount spent', expected: 10, actual: 9 },
    { code: 'row-anomaly' }
  ]
}

describe('fbReportReadingEvidence', () => {
  it('projects file name, window and warning columns', () => {
    const evidence = fbReportReadingEvidence(fbReportStored)
    expect(evidence.kind).toBe('csv')
    expect(evidence.capturedAt).toBe(1792700000000)
    expect(evidence.sourceDetail).toBe('report.csv')
    expect(evidence.scopeLabel).toBe('2026-10-01 — 2026-10-07')
    expect(evidence.scopeDetails).toEqual(['USD', '7-day click'])
    expect(evidence.includedCount).toBe(1)
    expect(evidence.includedUnit).toBe('accounts')
    expect(evidence.warnings).toEqual(['Amount spent', 'row-anomaly'])
  })

  it('keeps scope null when the file carried no window', () => {
    const evidence = fbReportReadingEvidence({
      ...fbReportStored,
      summary: { ...fbReportStored.summary, windowStart: null, windowEnd: null, currency: null, attribution: null }
    })
    expect(evidence.scopeLabel).toBeNull()
    expect(evidence.scopeDetails).toEqual([])
  })
})

describe('googleReportReadingEvidence', () => {
  const stored: GoogleReportStoredReading = {
    widgetId: 'w2',
    importedAt: 1792700000000,
    fileName: 'export.csv',
    contractVersion: 1,
    summary: {
      windowStart: '2026-10-01',
      windowEnd: '2026-10-07',
      accounts: [
        { accountId: '123-456', accountName: 'Main', currency: 'USD', spend: 1, impressions: 1, clicks: 1, conversions: 1, conversionValue: null, campaigns: [] }
      ],
      timezone: '(GMT) Greenwich Mean Time'
    },
    warnings: ['report-scope-only', 'totals-cross-check'],
    sourceUrl: 'https://ads.google.com/ul/report/detail'
  }

  it('projects the report host and drops the standing scope note', () => {
    const evidence = googleReportReadingEvidence(stored)
    expect(evidence.kind).toBe('link')
    expect(evidence.sourceDetail).toBe('ads.google.com')
    expect(evidence.scopeLabel).toBe('2026-10-01 — 2026-10-07')
    expect(evidence.scopeDetails).toEqual(['(GMT) Greenwich Mean Time'])
    expect(evidence.includedCount).toBe(1)
    expect(evidence.warnings).toEqual(['totals-cross-check'])
  })

  it('treats a reading without sourceUrl as a CSV import', () => {
    const evidence = googleReportReadingEvidence({ ...stored, sourceUrl: undefined })
    expect(evidence.kind).toBe('csv')
    expect(evidence.sourceDetail).toBe('export.csv')
  })
})

describe('ttMcpReadingEvidence', () => {
  const summary: TikTokReadingSummary = {
    transport: 'mcp',
    range: '7',
    startDate: '2026-10-22',
    endDate: '2026-10-28',
    totals: { spend: 1, impressions: 1, clicks: 1, ctr: 0, conversions: 1, costPerConversion: 1 },
    topCampaigns: [],
    source: 'oauth',
    generatedAt: 1792700000000,
    advertisers: [{ advertiserId: '7300000000001', name: 'Shop A', currency: 'USD' }],
    failed: [{ advertiserId: '7300000000002', name: null, currency: null, error: 'api' }],
    currency: 'USD',
    mixedCurrency: false
  }

  it('projects credential origin, window and failed accounts as excluded', () => {
    const evidence = ttMcpReadingEvidence(summary)
    expect(evidence.kind).toBe('mcp')
    expect(evidence.auth).toBe('oauth')
    expect(evidence.capturedAt).toBe(1792700000000)
    expect(evidence.scopeLabel).toBe('2026-10-22 — 2026-10-28')
    expect(evidence.includedCount).toBe(1)
    expect(evidence.includedUnit).toBe('accounts')
    expect(evidence.excludedNames).toEqual(['7300000000002'])
    expect(evidence.warnings).toEqual([])
  })

  it('surfaces truncation and mixed currency as caveats', () => {
    const evidence = ttMcpReadingEvidence({ ...summary, truncated: true, mixedCurrency: true })
    expect(evidence.warnings).toEqual(['truncated'])
    expect(evidence.scopeDetails).toEqual(['USD', 'mixed-currency'])
  })
})
