import { describe, expect, it } from 'vitest'
import { fbReportEntryUrl, parseFbReportReference, FB_REPORT_ENTRY_URL } from '../fbReportReference'
import { createBoard, createWidget, validateBoard } from '../boards'

function reportConfig(config: Record<string, unknown>) {
  const board = createBoard('Report')
  const widget = createWidget('fb-report-reading', 'Report', { x: 0, y: 0 })
  board.widgets = [{ ...widget, config }]
  return validateBoard(board)?.widgets[0]?.config ?? null
}

describe('saved FB report references', () => {
  it('preserves legacy IDs and strips unrelated tracking from scoped report links', () => {
    expect(parseFbReportReference(' 123 ')).toEqual({ reportId: '123' })
    const reference = parseFbReportReference(`${FB_REPORT_ENTRY_URL}?business_id=456&act=123456&selected_report_id=789&tracking=private#fragment`)
    expect(reference).toEqual({ reportId: '789', url: `${FB_REPORT_ENTRY_URL}?selected_report_id=789&business_id=456&act=123456` })
  })

  it.each([
    '', null, 123, 'x'.repeat(2001), 'https://example.com/?selected_report_id=123',
    'https://adsmanager.facebook.com.evil.test/adsmanager/reporting/business_view?selected_report_id=123',
    `${FB_REPORT_ENTRY_URL.replace('https:', 'http:')}?selected_report_id=123`,
    `${FB_REPORT_ENTRY_URL.replace('adsmanager.facebook.com', 'user:pass@adsmanager.facebook.com')}?selected_report_id=123`,
    `${FB_REPORT_ENTRY_URL.replace('adsmanager.facebook.com', 'adsmanager.facebook.com:8787')}?selected_report_id=123`,
    `${FB_REPORT_ENTRY_URL.replace('business_view', 'view')}?selected_report_id=123`,
    `${FB_REPORT_ENTRY_URL}?business_id=456`,
    `${FB_REPORT_ENTRY_URL}?selected_report_id=123&selected_report_id=456`,
    `${FB_REPORT_ENTRY_URL}?selected_report_id=123&business_id=abc`,
    `${FB_REPORT_ENTRY_URL}?selected_report_id=123&act=1`,
    `${FB_REPORT_ENTRY_URL}?selected_report_id=123&act=123456&act=234567`
  ])('rejects unsafe, oversized or ambiguous references: %s', (value) => {
    expect(parseFbReportReference(value)).toBeNull()
  })

  it('lets a new report link override all old browser scope, even when the link has no scope', () => {
    const old = `${FB_REPORT_ENTRY_URL}?selected_report_id=111&business_id=222&act=123456`
    const next = parseFbReportReference(`${FB_REPORT_ENTRY_URL}?selected_report_id=333&business_id=444&act=234567`)
    expect(fbReportEntryUrl(next, old)).toBe(next?.url)
    const unscoped = parseFbReportReference(`${FB_REPORT_ENTRY_URL}?selected_report_id=333`)
    expect(fbReportEntryUrl(unscoped, old)).toBe(`${FB_REPORT_ENTRY_URL}?selected_report_id=333`)
  })

  it('uses only unambiguous numeric scope from the current trusted FB page for legacy references', () => {
    const entry = new URL(fbReportEntryUrl(parseFbReportReference('333'), 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?business_id=444&act=234567'))
    expect(entry.searchParams.get('business_id')).toBe('444')
    expect(entry.searchParams.get('act')).toBe('234567')
    expect(entry.searchParams.get('selected_report_id')).toBe('333')
    expect(fbReportEntryUrl(null, `${FB_REPORT_ENTRY_URL}?act=123456&act=234567&business_id=bad`)).toBe(FB_REPORT_ENTRY_URL)
    expect(fbReportEntryUrl(null, 'https://example.com/?business_id=444&act=234567')).toBe(FB_REPORT_ENTRY_URL)
    expect(fbReportEntryUrl(null, 'about:blank')).toBe(FB_REPORT_ENTRY_URL)
  })

  it('persists scoped links and the chosen range without dropping it for an empty optional ID', () => {
    const link = `${FB_REPORT_ENTRY_URL}?selected_report_id=333&business_id=444`
    expect(reportConfig({ reportName: 'Other product', reportId: link, range: 'last7' }))
      .toEqual({ reportName: 'Other product', reportId: link, range: 'last7' })
    expect(reportConfig({ reportName: 'Other product', reportId: '', range: 'today' }))
      .toEqual({ reportName: 'Other product', range: 'today' })
    expect(reportConfig({ reportId: 'https://example.com' })).toBeNull()
  })
})
