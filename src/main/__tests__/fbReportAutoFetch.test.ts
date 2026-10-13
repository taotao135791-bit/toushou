import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  panel: null as unknown,
  navigate: vi.fn(async (_request: unknown) => undefined),
  csv: '',
  exported: false,
  target: true,
  canOpen: true,
  canApply: true,
  applied: false,
  lastClick: '',
  savedLink: null as string | null,
  clickedLink: false,
  exportNameScript: '',
  moveDatePicker: false,
  dateProbes: 0,
  presses: [] as { label: string; y: number | undefined }[],
  clicks: [] as string[],
  currentUrl: '',
  targetScript: '',
  savedLinkScript: '',
  alreadyList: false,
  openedList: false,
  registry: vi.fn(() => [{ act: '987654', businessId: '999' }])
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/report-test' }, BrowserWindow: { fromWebContents: () => null } }))
vi.mock('node:fs', () => ({ mkdirSync: vi.fn(), readdirSync: () => [], statSync: () => ({ size: 100 }), unlinkSync: vi.fn(), readFileSync: () => harness.csv }))
vi.mock('../browserUse', () => ({ runAction: harness.navigate, withBrowserActionLock: (fn: () => unknown) => fn() }))
vi.mock('../browserPanel', () => ({ getActiveBrowserPanel: () => harness.panel, withBrowserReadingViewport: (_panel: unknown, fn: () => unknown) => fn() }))
vi.mock('../fbReadingAccounts', () => ({ listFbReadingAccounts: harness.registry }))
import { autoFetchFbReportCsv } from '../fbReportAutoFetch'

const csv = (day: string): string =>
  '账户名称,单日,货币,已花费金额 (USD),展示次数,报告开始日期,报告结束日期\n' +
  `,,USD,10,100,${day},${day}\nA,${day},USD,10,100,${day},${day}\n`

async function run(reference?: string): Promise<Awaited<ReturnType<typeof autoFetchFbReportCsv>>> {
  let settled = false
  const pending = autoFetchFbReportCsv('My report', reference, 'today').finally(() => { settled = true })
  for (let i = 0; i < 500 && !settled; i++) await vi.advanceTimersByTimeAsync(500)
  return pending
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 10, 12))
  harness.target = harness.canOpen = harness.canApply = true
  harness.applied = harness.exported = false
  harness.csv = csv('2026-10-10')
  harness.lastClick = ''
  harness.clicks = []
  harness.moveDatePicker = false
  harness.dateProbes = 0
  harness.presses = []
  harness.clickedLink = false
  harness.savedLink = null
  harness.currentUrl = 'https://adsmanager.facebook.com/adsmanager/reporting/business_view'
  harness.registry.mockClear()
  harness.alreadyList = harness.openedList = false
  harness.navigate.mockReset()
  harness.navigate.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { url?: string } | undefined
    if (request?.url) harness.currentUrl = request.url
    if (request?.url === harness.savedLink && harness.canOpen) harness.target = true
  })
  const session = Object.assign(new EventEmitter(), { setDownloadPath: vi.fn() })
  const rect = { x: 0, y: 0, w: 100, h: 30 }
  const wc = {
    session, isDestroyed: () => false, getURL: () => harness.currentUrl,
    getZoomFactor: () => 1, focus: vi.fn(),
    executeJavaScript: vi.fn(async (script: string) => {
      if (script.includes('const urls = [...new Set')) { harness.savedLinkScript = script; return harness.savedLink }
      if (script.includes('anchor.focus();')) { harness.lastClick = 'saved-anchor'; return true }
      if (script.includes('const create =')) return true
      if (script.includes('querySelectorAll("h1, [role=heading]")')) { harness.targetScript = script; return harness.target }
      if (script.includes('.filter(visible).map((el) => clean')) return [harness.applied ? '今天：2026年10月10日' : '过去 14 天：2026年9月26日 – 2026年10月9日']
      if (script.includes('let best=null')) {
        harness.lastClick = 'date-picker'
        harness.dateProbes++
        return harness.moveDatePicker ? { ...rect, y: harness.dateProbes === 1 ? 10 : 160 } : rect
      }
      if (script.includes('[aria-busy=true]')) return true
      if (script.includes('const exportDialogs =')) { harness.exportNameScript = script; return true }
      if (script.includes('.some((d) => /csv|xlsx')) return true
      const located = script.match(/return locate\((\[.*?\]),/)
      if (located) {
        const labels = JSON.parse(located[1]) as string[]
        harness.lastClick = labels[0]
        if (labels[0] === '创建报告' && !harness.alreadyList && !harness.openedList) return null
        if (labels[0] === '所有报告' && harness.alreadyList) return null
        if (labels[0] === '更新') return null // Today applies immediately, no Update button.
        return rect
      }
      // Toolbar export locator; diagnostics are never needed in the successful path.
      harness.lastClick = 'toolbar-export'
      return rect
    }),
    sendInputEvent: (event: { type: string; keyCode?: string; y?: number }) => {
      if (event.type === 'mouseDown') harness.presses.push({ label: harness.lastClick, y: event.y })
      if (event.type === 'keyUp' && event.keyCode === 'Return' && harness.lastClick === 'saved-anchor') {
        harness.clickedLink = true
        if (harness.canOpen) harness.target = true
      }
      if (event.type !== 'mouseUp') return
      const label = harness.lastClick
      harness.clicks.push(label)
      if (label === '所有报告') harness.openedList = true
      if (label === 'My report' && harness.canOpen) harness.target = true
      if (label === '今天' && harness.canApply) harness.applied = true
      if (label === '导出') {
        harness.exported = true
        // An unrelated PDF cannot fulfill the CSV waiter.
        session.emit('will-download', {}, { getFilename: () => 'unrelated.pdf', setSavePath: vi.fn() })
        session.emit('will-download', {}, { getFilename: () => 'Other report.csv', setSavePath: vi.fn() })
        const item = Object.assign(new EventEmitter(), {
          getFilename: () => 'My report.csv', getMimeType: () => 'text/csv', getTotalBytes: () => 100,
          setSavePath: vi.fn()
        })
        session.emit('will-download', {}, item)
        queueMicrotask(() => item.emit('done', {}, 'completed'))
      }
    }
  }
  harness.panel = { webContents: wc, getBounds: () => ({ width: 720, height: 900 }) }
})
afterEach(() => vi.useRealTimers())

describe('FB report automatic export gates', () => {
  it('opens a report when the entry is already the saved list and All reports is absent', async () => {
    harness.target = false
    harness.alreadyList = true
    expect((await run()).ok).toBe(true)
    expect(harness.clicks).toContain('My report')
    expect(harness.clicks).not.toContain('所有报告')
  })
  it('uses the new report link scope instead of the old registered or currently open account', async () => {
    harness.currentUrl = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?business_id=111&act=123456'
    const link = 'https://adsmanager.facebook.com/adsmanager/reporting/business_view?selected_report_id=789&business_id=222&act=234567'
    expect((await run(link)).ok).toBe(true)
    expect(harness.navigate).toHaveBeenCalledWith(expect.objectContaining({ url: link }))
    expect(harness.registry).not.toHaveBeenCalled()
  })
  it('uses the current FB scope for legacy report IDs without consulting the old registry', async () => {
    harness.currentUrl = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?business_id=222&act=234567'
    expect((await run('789')).ok).toBe(true)
    const request = harness.navigate.mock.calls[0][0] as unknown as { url: string }
    const url = new URL(request.url)
    expect(url.searchParams.get('business_id')).toBe('222')
    expect(url.searchParams.get('act')).toBe('234567')
    expect(url.searchParams.get('selected_report_id')).toBe('789')
    expect(harness.registry).not.toHaveBeenCalled()
  })
  it('refuses invalid links before any navigation or export', async () => {
    expect((await run('https://example.com/?selected_report_id=789')).ok).toBe(false)
    expect(harness.navigate).not.toHaveBeenCalled()
    expect(harness.exported).toBe(false)
  })
  it('refuses ambiguous same-named saved reports instead of clicking the first one', async () => {
    harness.target = false
    harness.savedLink = 'ambiguous-report'
    expect((await run()).error).toBe('report-not-found')
    expect(harness.exported).toBe(false)
    expect(harness.clicks).not.toContain('My report')
  })
  it('refuses a saved link for a different explicit report ID', async () => {
    harness.target = false
    harness.savedLink = 'https://adsmanager.facebook.com/adsmanager/reporting/business_view?selected_report_id=456'
    expect((await run('789')).error).toBe('report-not-found')
    expect(harness.exported).toBe(false)
    expect(harness.clickedLink).toBe(false)
  })
  it('verifies both heading and report ID in the real page script', async () => {
    await run('789')
    const heading = { textContent: 'My report', getBoundingClientRect: () => ({ width: 100, height: 30 }) }
    const context = {
      URL,
      location: { href: 'https://adsmanager.facebook.com/adsmanager/reporting/business_view?selected_report_id=789' },
      document: { querySelectorAll: () => [heading] },
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
    }
    expect(runInNewContext(harness.targetScript, context)).toBe(true)
    context.location.href = context.location.href.replace('789', '456')
    expect(runInNewContext(harness.targetScript, context)).toBe(false)
  })
  it('filters same-named report links by the explicit ID in the real locator script', async () => {
    harness.target = false
    harness.savedLink = 'https://adsmanager.facebook.com/adsmanager/reporting/business_view?selected_report_id=789'
    await run('789')
    const anchors = ['456', '789'].map((id) => ({
      href: `https://adsmanager.facebook.com/adsmanager/reporting/business_view?selected_report_id=${id}`,
      textContent: 'My report', getAttribute: () => null
    }))
    const context = { URL, document: { querySelectorAll: () => anchors } }
    expect(runInNewContext(harness.savedLinkScript, context)).toBe(anchors[1].href)
    anchors.pop()
    expect(runInNewContext(harness.savedLinkScript, context)).toBeNull()
  })
  it('exports today after the preset applies without Update, ignoring unrelated downloads', async () => {
    const result = await run()
    expect(result.ok).toBe(true)
    expect(result.filePath).toMatch(/\.csv$/)
    expect(harness.clicks.indexOf('今天')).toBeLessThan(harness.clicks.indexOf('toolbar-export'))
    expect(harness.clicks).not.toContain('更新')
  })
  it('re-locates a moved date picker before pressing instead of clicking the old toolbar position', async () => {
    harness.moveDatePicker = true
    expect((await run()).ok).toBe(true)
    const presses = harness.presses.filter((press) => press.label === 'date-picker')
    expect(presses).toEqual([{ label: 'date-picker', y: 175 }])
  })
  it('opens the saved report before choosing a date when a deep link lands on untitled', async () => {
    harness.target = false
    expect((await run()).ok).toBe(true)
    expect(harness.clicks.indexOf('My report')).toBeLessThan(harness.clicks.indexOf('今天'))
  })
  it('uses the saved report link when its name is clipped in the list', async () => {
    harness.target = false
    harness.savedLink = 'https://adsmanager.facebook.com/adsmanager/reporting/business_view?selected_report_id=456'
    expect((await run()).ok).toBe(true)
    expect(harness.clickedLink).toBe(true)
    expect(harness.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ url: harness.savedLink }))
    expect(harness.clicks).not.toContain('My report')
  })
  it('does not navigate to an offsite link even if its report name matches', async () => {
    harness.target = harness.canOpen = false
    harness.savedLink = 'https://example.com/adsmanager/reporting/business_view?selected_report_id=456'
    expect((await run()).error).toBe('report-not-found')
    expect(harness.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ url: harness.savedLink }))
    expect(harness.exported).toBe(false)
    expect(harness.clickedLink).toBe(false)
  })
  it('does not export an unconfirmed report', async () => {
    harness.target = harness.canOpen = false
    expect((await run()).error).toBe('report-not-found')
    expect(harness.exported).toBe(false)
  })
  it('stops before export if the date preset did not apply', async () => {
    harness.canApply = false
    expect((await run()).error).toBe('fetch-failed')
    expect(harness.exported).toBe(false)
  })
  it('checks the visible format dialog and normalizes spaces and zero-width characters', async () => {
    await run()
    const dialog = (text: string, name: string) => ({
      innerText: text, getBoundingClientRect: () => ({ width: 400, height: 300 }),
      querySelectorAll: () => [{ value: name }]
    })
    const announcement = dialog('Announcement', 'Other report')
    const format = dialog('Excel (.xlsx) CSV (.csv)', 'My\u200b  report.csv')
    const context = {
      document: { querySelectorAll: () => [announcement, format] },
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
    }
    expect(runInNewContext(harness.exportNameScript, context)).toBe(true)
    format.querySelectorAll = () => [{ value: 'Another report.csv' }]
    expect(runInNewContext(harness.exportNameScript, context)).toBe(false)
  })
  it('rejects a downloaded CSV for a different window', async () => {
    harness.csv = csv('2026-10-09')
    const result = await run()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('日期校验')
  })
})
