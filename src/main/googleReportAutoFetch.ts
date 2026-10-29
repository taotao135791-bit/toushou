import { chmodSync, closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { getActiveBrowserPanel, withBrowserReadingViewport } from './browserPanel'
import { runAction, withBrowserActionLock } from './browserUse'
import { validGoogleReportUrl, type GoogleReportAutoFetchResult, type GoogleReportContext } from '../shared/googleReport'
import { buildGoogleExportLocator, PAGE_EVIDENCE_SCRIPT, parseGooglePageEvidence, type GooglePageEvidence } from './googleReportPage'

export interface GoogleExportDriver {
  navigate(url: string): Promise<void>
  currentUrl(): string
  context(): Promise<GoogleReportContext | null>
  click(labels: string[]): Promise<boolean>
  armDownload(): { started(): boolean; done: Promise<string>; cancel(): void }
}
/** Extracted flow so failure and redirect behavior are testable without Electron. */
export async function runGoogleReportExport(url: string, driver: GoogleExportDriver): Promise<GoogleReportAutoFetchResult> {
  if (!validGoogleReportUrl(url)) return { ok: false, error: 'invalid-url' }
  try { await driver.navigate(url) } catch { return { ok: false, error: 'navigation-failed' } }
  const landed = driver.currentUrl()
  if (/^https:\/\/accounts\.google\.com\//i.test(landed)) return { ok: false, error: 'login-required' }
  // Navigation must preserve the requested route and identity parameters. A
  // redirect to another account/report is not evidence for this link.
  const target = new URL(url)
  let current: URL
  try { current = new URL(landed) } catch { return { ok: false, error: 'navigation-failed' } }
  if (!validGoogleReportUrl(landed) || target.pathname !== current.pathname ||
      [...target.searchParams].some(([k, v]) => !current.searchParams.getAll(k).includes(v))) return { ok: false, error: 'navigation-failed' }
  const samePage = (): boolean => {
    try {
      const active = new URL(driver.currentUrl())
      return validGoogleReportUrl(active.href) && active.pathname === target.pathname && [...target.searchParams].every(([k, v]) => active.searchParams.getAll(k).includes(v))
    } catch { return false }
  }
  const context = await driver.context()
  if (!context || !samePage()) return { ok: false, error: 'context-unavailable' }
  const download = driver.armDownload()
  let handedOff = false
  try {
    if (!samePage() || !(await driver.click(['download', '下载', 'export', '导出']))) return { ok: false, error: 'export-button-not-found' }
    if (!samePage()) return { ok: false, error: 'navigation-failed' }
    if (!download.started() && !(await driver.click(['csv', '.csv', 'csv (.csv)', 'download csv', '下载 csv', '逗号分隔值 (.csv)']))) return { ok: false, error: 'csv-option-not-found' }
    if (!samePage()) return { ok: false, error: 'navigation-failed' }
    let filePath: string | undefined
    try {
      filePath = await download.done
      const after = await driver.context()
      if (!samePage() || !after || JSON.stringify(after) !== JSON.stringify(context)) {
        try { unlinkSync(filePath) } catch { /* best-effort cleanup */ }
        return { ok: false, error: 'context-unavailable' }
      }
      handedOff = true
      return { ok: true, filePath, context }
    }
    catch (e) {
      if (filePath) { try { unlinkSync(filePath) } catch { /* best-effort cleanup */ } }
      return { ok: false, error: e instanceof Error && e.message === 'download-timeout' ? 'download-timeout' : 'download-failed' }
    }
  } finally {
    download.cancel()
    if (!handedOff) {
      // The download may finish just before an early return, in which case
      // cancel is already a no-op. Clean up that completed file as well.
      void download.done.then((file) => { try { unlinkSync(file) } catch { /* best-effort */ } }, () => undefined)
    }
  }
}

export function autoFetchGoogleReportCsv(url: string): Promise<GoogleReportAutoFetchResult> {
  if (!validGoogleReportUrl(url)) return Promise.resolve({ ok: false, error: 'invalid-url' })
  return withBrowserActionLock(async () => {
    const result = await runAction({ action: 'navigate', url, keepRoute: true, background: false, navTimeoutMs: 45_000 }).catch(() => null)
    const panel = getActiveBrowserPanel()
    if (!panel || panel.webContents.isDestroyed()) return { ok: false, error: 'panel-not-open' } as GoogleReportAutoFetchResult
    if (!result?.ok) return { ok: false, error: 'navigation-failed' } as GoogleReportAutoFetchResult
    const wc = panel.webContents
    const requested = new URL(url)
    const stillTarget = (): boolean => {
      try {
        const active = new URL(wc.getURL())
        return !wc.isDestroyed() && validGoogleReportUrl(active.href) && active.pathname === requested.pathname && [...requested.searchParams].every(([key, value]) => active.searchParams.getAll(key).includes(value))
      } catch { return false }
    }
    return withBrowserReadingViewport(panel, async () => runGoogleReportExport(url, {
      // Navigation already performed above, so the panel may be constructed.
      navigate: async () => undefined,
      currentUrl: () => wc.isDestroyed() ? '' : wc.getURL(),
      context: async () => {
        for (let attempt = 0; attempt < 20 && stillTarget(); attempt++) {
          const raw: unknown = await wc.executeJavaScript(PAGE_EVIDENCE_SCRIPT, true).catch(() => null)
          if (raw && typeof raw === 'object') {
            const evidence = raw as GooglePageEvidence
            if (Array.isArray(evidence.accountLabels) && Array.isArray(evidence.dateLabels) && Array.isArray(evidence.currencies) && Array.isArray(evidence.timezones)) {
              const context = parseGooglePageEvidence(evidence)
              if (context) return context
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        return null
      },
      click: async (labels) => {
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!stillTarget()) return false
          const position: unknown = await wc.executeJavaScript(buildGoogleExportLocator(labels, labels.includes('download')), true).catch(() => null)
          if (stillTarget() && position && typeof position === 'object' && 'x' in position && 'y' in position && typeof position.x === 'number' && typeof position.y === 'number') {
            const z = wc.getZoomFactor() || 1, x = Math.round(position.x * z), y = Math.round(position.y * z)
            wc.sendInputEvent({ type: 'mouseMove', x, y })
            wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
            wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
            return true
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        return false
      },
      armDownload: () => {
        let started = false, settled = false, activeItem: Electron.DownloadItem | undefined, pendingFile: string | undefined, cancel = (): void => undefined
        const done = new Promise<string>((resolve, reject) => {
          const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); wc.session.removeListener('will-download', onDownload); fn() }
          const timer = setTimeout(() => {
            try { activeItem?.cancel() } catch { /* already ended */ }
            if (pendingFile) { try { unlinkSync(pendingFile) } catch { /* best-effort */ } }
            finish(() => reject(new Error('download-timeout')))
          }, 90_000)
          const onDownload = (_event: Electron.Event, item: Electron.DownloadItem, origin: Electron.WebContents): void => {
            if (started || origin !== wc || !/\.csv$/i.test(item.getFilename()) || !stillTarget()) return
            started = true
            activeItem = item
            try {
            const dir = path.join(app.getPath('userData'), 'google-report-downloads')
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            chmodSync(dir, 0o700)
            const filePath = path.join(dir, `${randomUUID()}.csv`)
            pendingFile = filePath
            closeSync(openSync(filePath, 'wx', 0o600))
            item.setSavePath(filePath)
            item.once('done', (_e, state) => finish(() => {
              if (state === 'completed') resolve(filePath)
              else { try { unlinkSync(filePath) } catch { /* best-effort */ }; reject(new Error('download-failed')) }
            }))
            } catch {
              try { item.cancel() } catch { /* already ended */ }
              if (pendingFile) { try { unlinkSync(pendingFile) } catch { /* best-effort */ } }
              finish(() => reject(new Error('download-failed')))
            }
          }
          cancel = () => {
            if (!settled) {
              try { activeItem?.cancel() } catch { /* already ended */ }
              if (pendingFile) { try { unlinkSync(pendingFile) } catch { /* best-effort */ } }
              finish(() => reject(new Error('cancelled')))
            }
          }
          wc.session.on('will-download', onDownload)
        })
        done.catch(() => undefined)
        return { started: () => started, done, cancel }
      }
    }))
  }).catch((): GoogleReportAutoFetchResult => ({ ok: false, error: 'fetch-failed' }))
}

export { validGoogleReportUrl } from '../shared/googleReport'
