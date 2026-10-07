// FB 报表自动导出：后台面板打开广告报告 → 定位目标报表 → 导出 CSV →
// will-download 落盘。全程只读（不点「保存」，不碰报表设置），与其它浏览
// 器动作共用一把串行锁；每一步 fail-closed，返回稳定错误码和有界现场文
// 本。页面交互全部走「脚本定位 + sendInputEvent 真实点击」——FB 关键控
// 件会过滤合成 el.click()，只有可信输入事件有效。
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { runAction, withBrowserActionLock } from './browserUse'
import { getActiveBrowserPanel } from './browserPanel'
import { listFbReadingAccounts } from './fbReadingAccounts'
import { FbReportFetchErrorCode } from '../shared/fbReportCsv'

/** Primary entry: the business-scoped Ads Reporting view. */
const REPORTING_BUSINESS_VIEW_URL = 'https://adsmanager.facebook.com/adsmanager/reporting/business_view'
/** Fallback entries, tried in order when the primary one fails to land. */
const FALLBACK_URLS = [
  REPORTING_BUSINESS_VIEW_URL,
  'https://adsmanager.facebook.com/adsreporting/',
  'https://business.facebook.com/reports/'
]
const DOWNLOAD_DIR_FILES_LIMIT = 20
const NAV_TIMEOUT_MS = 45_000
const PAGE_READY_TIMEOUT_MS = 25_000
const CLICK_TIMEOUT_MS = 12_000
const REPORT_OPEN_TIMEOUT_MS = 30_000
const DIALOG_TIMEOUT_MS = 8_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const DETAIL_LIMIT = 300

export interface FbReportFetchResult {
  ok: boolean
  filePath?: string
  error?: FbReportFetchErrorCode
  detail?: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const bounded = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, DETAIL_LIMIT)

// ---------------------------------------------------------------------------
// Page scripts — text-matched, bilingual, class-free, fail closed. They only
// LOCATE targets (smallest matching rect, viewport coordinates); Main clicks
// via webContents.sendInputEvent so every event is trusted input.
// ---------------------------------------------------------------------------

const locateByLabel = (labels: readonly string[], inDialog: boolean, prefix: boolean): string =>
  '(() => {' +
  'const labels = ' + JSON.stringify(labels) + ';' +
  'const scope = ' + (inDialog ? 'document.querySelector("[role=dialog]")' : 'document') + ';' +
  'if (!scope) return null;' +
  'let best = null; let bestArea = Infinity;' +
  'for (const el of scope.querySelectorAll("a, button, [role=button], [role=link], [role=menuitem], [role=option], [role=radio], [role=row], tr, span, div")) {' +
  '  const text = (el.innerText || "").replace(/\\s+/g, " ").trim();' +
  '  if (!text || text.length > 240) continue;' +
  '  const hit = ' + (prefix ? 'labels.some((l) => text === l || text.startsWith(l))' : 'labels.some((l) => text === l)') + ';' +
  '  if (!hit) continue;' +
  '  const r = el.getBoundingClientRect();' +
  '  if (r.width < 2 || r.height < 2) continue;' +
  '  const area = r.width * r.height;' +
  '  if (area < bestArea) { best = r; bestArea = area; }' +
  '}' +
  'if (!best) return null;' +
  'return { x: best.x, y: best.y, w: best.width, h: best.height };' +
  '})()'

const LOCATE_ALL_REPORTS = locateByLabel(['所有报告', 'All reports'], false, false)
const LOCATE_EXPORT = locateByLabel(['导出', 'Export'], false, false)
const LOCATE_CSV = locateByLabel(['CSV', 'csv', '逗号分隔', 'Comma-separated'], true, true)
const LOCATE_CONFIRM = locateByLabel(['导出', '下载', 'Export', 'Download', '确认', 'Confirm'], true, false)
const locateReportByName = (name: string): string => locateByLabel([name], false, true)

const LIST_READY_SCRIPT = `(() => {
  const text = (document.body.innerText || '').slice(0, 2500)
  const bad = /无法显示内容|链接可能已过期|isn't available|link may have expired/i.test(text)
  const create = /创建报告|Create report/.test(text)
  const visited = /上次访问|Last accessed|编辑时间|Edited/.test(text)
  const header = /所有报告|All reports|报告名称|Report name/.test(text)
  return { ready: !bad && (create || visited || header), url: location.href, snippet: text.replace(/\\s+/g, ' ').slice(0, 300) }
})()`

const DIALOG_PRESENT_SCRIPT = `(() => document.querySelector('[role=dialog]') !== null)`

const SNIPPET_SCRIPT = '((document.body.innerText || "").replace(/\\s+/g, " ")).slice(0, 300)'

// ---------------------------------------------------------------------------
// Download wiring
// ---------------------------------------------------------------------------

function downloadsDir(): string {
  const dir = path.join(app.getPath('userData'), 'fb-report-downloads')
  mkdirSync(dir, { recursive: true })
  try {
    const files = readdirSync(dir)
      .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const stale of files.slice(DOWNLOAD_DIR_FILES_LIMIT)) {
      try {
        unlinkSync(path.join(dir, stale.name))
      } catch {
        // best-effort cleanup
      }
    }
  } catch {
    // best-effort cleanup
  }
  return dir
}

/** Arms a one-shot download waiter on the panel session. */
function armDownload(session: Electron.Session, dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      session.removeListener('will-download', onWillDownload)
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('download-timeout'))), DOWNLOAD_TIMEOUT_MS)
    const onWillDownload = (_event: unknown, item: Electron.DownloadItem): void => {
      const safeName = 'fb-report-' + Date.now() + '-' + item.getFilename().replace(/[^\\w.-]+/g, '_').slice(-80)
      const target = path.join(dir, safeName)
      item.setSavePath(target)
      item.once('done', (_e, state) => {
        if (state === 'completed') finish(() => resolve(target))
        else finish(() => reject(new Error('download-' + state)))
      })
    }
    session.setDownloadPath(dir)
    session.on('will-download', onWillDownload)
  })
}

// ---------------------------------------------------------------------------
// Panel helpers
// ---------------------------------------------------------------------------

async function poll(script: string, timeoutMs: number, intervalMs = 1_500): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      last = await getActiveBrowserPanel()?.webContents.executeJavaScript(script, true)
    } catch {
      last = null
    }
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

/** Trusted-input click on a located rect (see locateByLabel). */
async function realClick(locateScript: string, timeoutMs: number, intervalMs = 800): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const panel = getActiveBrowserPanel()
    if (panel && !panel.webContents.isDestroyed()) {
      const rect = await panel.webContents.executeJavaScript(locateScript, true).catch(() => null)
      if (rect && typeof rect === 'object' && typeof (rect as { x?: unknown }).x === 'number') {
        const box = rect as { x: number; y: number; w: number; h: number }
        const x = Math.round(box.x + box.w / 2)
        const y = Math.round(box.y + box.h / 2)
        panel.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        await sleep(120)
        panel.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        await sleep(60)
        panel.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        return true
      }
    }
    await sleep(intervalMs)
  }
  return false
}

async function panelUrl(): Promise<string> {
  const panel = getActiveBrowserPanel()
  if (!panel || panel.webContents.isDestroyed()) return ''
  return panel.webContents.getURL()
}

async function pageSnippet(): Promise<string> {
  try {
    const text = await getActiveBrowserPanel()?.webContents.executeJavaScript(SNIPPET_SCRIPT, true)
    return bounded(typeof text === 'string' ? text : '')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export function autoFetchFbReportCsv(reportName: string, reportId?: string): Promise<FbReportFetchResult> {
  return withBrowserActionLock<FbReportFetchResult>(async () => {
    const dir = downloadsDir()
    const navigate = async (url: string): Promise<void> => {
      try {
        await runAction({
          action: 'navigate',
          url,
          keepRoute: true,
          background: true,
          navTimeoutMs: NAV_TIMEOUT_MS
        })
      } catch {
        // redirect chains can abort the measured load yet still land
      }
    }

    // 1) Open Ads Reporting under the registry's business scope. With a
    //    reportId the deep link should land directly on the saved report.
    const businessId = listFbReadingAccounts()
      .map((account) => account.businessId)
      .find((id): id is string => typeof id === 'string' && id.length > 0)
    const deepLink = reportId !== undefined && /^\d{1,32}$/.test(reportId)
    const primaryUrl =
      REPORTING_BUSINESS_VIEW_URL +
      (businessId ? '?business_id=' + businessId : '') +
      (deepLink ? (businessId ? '&' : '?') + 'selected_report_id=' + reportId : '')
    await navigate(primaryUrl)
    let url = await panelUrl()
    if (!url) return { ok: false, error: 'panel-not-open' }
    if (/login\.(facebook|business\.facebook)\.com|\/login/i.test(url)) {
      return { ok: false, error: 'login-required', detail: bounded(url) }
    }

    // 2) Land on the reporting surface (fall back through known entries).
    const listReady = async (): Promise<{ ready: boolean; snippet: string }> => {
      const polled = await poll(LIST_READY_SCRIPT, PAGE_READY_TIMEOUT_MS)
      if (polled && typeof polled === 'object') {
        const info = polled as { ready?: boolean; snippet?: string; url?: string }
        return { ready: info.ready === true, snippet: (info.url ?? '') + ' | ' + (info.snippet ?? '') }
      }
      return { ready: false, snippet: await pageSnippet() }
    }
    let landing = await listReady()
    if (!landing.ready) {
      for (const fallback of FALLBACK_URLS) {
        await navigate(fallback)
        const fallbackUrl = await panelUrl()
        if (/login\.(facebook|business\.facebook)\.com|\/login/i.test(fallbackUrl)) {
          return { ok: false, error: 'login-required', detail: bounded(fallbackUrl) }
        }
        landing = await listReady()
        if (landing.ready) break
      }
    }
    if (!landing.ready) return { ok: false, error: 'navigation-failed', detail: landing.snippet }

    // 3) Open the target report. business_view can land inside an arbitrary
    //    report view; the switcher menu (保存 ▾) and the 所有报告 list both
    //    expose named rows — try direct, menu, then list.
    let opened = false
    for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
      opened = await realClick(locateReportByName(reportName), 8_000)
      if (opened) break
      await realClick(locateByLabel(['打开下拉菜单', 'Open dropdown menu'], false, false), 4_000)
      await sleep(1_200)
      opened = await realClick(locateReportByName(reportName), 6_000)
      if (!opened) {
        await realClick(LOCATE_ALL_REPORTS, 4_000)
        await sleep(1_500)
      }
    }
    if (!opened) return { ok: false, error: 'report-not-found', detail: await pageSnippet() }

    // 4) Export: toolbar 导出 → dialog → CSV → confirm, with the one-shot
    //    download waiter armed before the final click.
    await sleep(2_000)
    const exportClicked = await realClick(LOCATE_EXPORT, REPORT_OPEN_TIMEOUT_MS)
    if (!exportClicked) {
      return { ok: false, error: 'export-button-not-found', detail: await pageSnippet() }
    }
    const dialog = await poll(DIALOG_PRESENT_SCRIPT, DIALOG_TIMEOUT_MS, 700)
    if (dialog !== true) {
      return { ok: false, error: 'export-button-not-found', detail: await pageSnippet() }
    }
    const csvClicked = await realClick(LOCATE_CSV, CLICK_TIMEOUT_MS)
    if (!csvClicked) {
      return { ok: false, error: 'csv-option-not-found', detail: await pageSnippet() }
    }
    const panel = getActiveBrowserPanel()
    if (!panel || panel.webContents.isDestroyed()) return { ok: false, error: 'panel-not-open' }
    const download = armDownload(panel.webContents.session, dir)
    const confirmed = await realClick(LOCATE_CONFIRM, CLICK_TIMEOUT_MS)
    if (!confirmed) {
      return { ok: false, error: 'csv-option-not-found', detail: await pageSnippet() }
    }
    try {
      const filePath = await download
      return { ok: true, filePath }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'download-failed'
      if (message === 'download-timeout') return { ok: false, error: 'download-timeout' }
      return { ok: false, error: 'download-failed', detail: bounded(message) }
    }
  }).catch((error: unknown): FbReportFetchResult => ({
    ok: false,
    error: 'fetch-failed',
    detail: bounded(error instanceof Error ? error.message : String(error))
  }))
}
