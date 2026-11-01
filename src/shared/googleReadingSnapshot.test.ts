import { describe, expect, it } from 'vitest'
import { googleReadingSnapshot } from './googleReadingSnapshot'
import type { GoogleReportStoredReading } from './googleReport'

describe('saving Google report readings', () => {
  const reading: GoogleReportStoredReading = { widgetId: 'test', importedAt: 123, contractVersion: 1, fileName: 'private-file.csv', sourceUrl: 'https://ads.google.com/aw/campaigns?ocid=private', warnings: [], summary: { windowStart: '2026-10-01', windowEnd: '2026-10-03', timezone: 'GMT+8', accounts: [{ accountId: '1234567890', accountName: 'Test account', currency: 'EUR', spend: 12, impressions: null, clicks: 0, conversions: 0.5, conversionValue: 10, campaigns: [] }] } }
  it('pins source dates and unknown metrics without copying private URLs or file paths', () => {
    const snapshot = googleReadingSnapshot(reading, 200)
    expect(snapshot?.window).toEqual({ start: '2026-10-01', end: '2026-10-03' })
    expect(snapshot?.accounts[0]).toMatchObject({ platform: 'google', sourceAt: 123, currency: 'EUR', previousSpend: null, impressions: null, clicks: 0, conversions: 0.5 })
    expect(JSON.stringify(snapshot)).not.toContain('private')
    expect(snapshot?.capturedAt).toBe(200)
  })
  it('refuses invalid snapshots rather than changing bad values to zero', () => {
    const invalid = structuredClone(reading)
    invalid.summary.accounts[0].spend = Number.NaN
    expect(googleReadingSnapshot(invalid, 200)).toBeNull()
  })
})
