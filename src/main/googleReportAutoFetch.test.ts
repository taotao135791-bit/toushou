import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('./browserUse', () => ({ runAction: vi.fn(), withBrowserActionLock: (fn: () => unknown) => fn() }))
vi.mock('./browserPanel', () => ({ getActiveBrowserPanel: vi.fn(), withBrowserReadingViewport: (_: unknown, fn: () => unknown) => fn() }))
import { runGoogleReportExport, validGoogleReportUrl, type GoogleExportDriver } from './googleReportAutoFetch'

const url = 'https://ads.google.com/aw/campaigns?ocid=123'
const context = { accountId: '1234567890', accountName: 'Demo', currency: 'USD', timezone: 'GMT+00', windowStart: '2026-10-29', windowEnd: '2026-10-29' }
function driver(overrides: Partial<GoogleExportDriver> = {}): GoogleExportDriver {
  return { navigate: async () => undefined, currentUrl: () => url, context: async () => context, click: async () => true, armDownload: () => ({ started: () => false, done: Promise.resolve('/tmp/result.csv'), cancel: () => undefined }), ...overrides }
}
describe('Google read-only export', () => {
  it('rejects other origins and credentials', () => {
    expect(validGoogleReportUrl('https://ads.google.com.evil.example/aw/campaigns')).toBe(false)
    expect(validGoogleReportUrl('https://user@ads.google.com/aw/campaigns')).toBe(false)
    expect(validGoogleReportUrl(url)).toBe(true)
  })
  it('downloads only after an export and CSV choice', async () => {
    const click = vi.fn().mockResolvedValue(true)
    expect(await runGoogleReportExport(url, driver({ click }))).toEqual({ ok: true, filePath: '/tmp/result.csv', context })
    expect(click).toHaveBeenCalledTimes(2)
  })
  it('refuses a redirected account or login before any click', async () => {
    const click = vi.fn()
    expect(await runGoogleReportExport(url, driver({ click, currentUrl: () => 'https://ads.google.com/aw/campaigns?ocid=999' }))).toMatchObject({ ok: false, error: 'navigation-failed' })
    expect(await runGoogleReportExport(url, driver({ click, currentUrl: () => 'https://accounts.google.com/login' }))).toMatchObject({ ok: false, error: 'login-required' })
    expect(click).not.toHaveBeenCalled()
  })
  it('stops when the CSV option cannot be identified', async () => {
    const click = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const cancel = vi.fn()
    const d = driver({ click, armDownload: () => ({ started: () => false, done: Promise.resolve('/tmp/x'), cancel }) })
    expect(await runGoogleReportExport(url, d)).toMatchObject({ ok: false, error: 'csv-option-not-found' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('context evidence', () => {
  it('fails closed if context is absent or changes before download ends', async () => {
    expect(await runGoogleReportExport(url, driver({ context: async () => null }))).toMatchObject({ ok: false, error: 'context-unavailable' })
    const get = vi.fn().mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, accountId: '0000000000' })
    expect(await runGoogleReportExport(url, driver({ context: get }))).toMatchObject({ ok: false, error: 'context-unavailable' })
  })
  it('removes a completed export when reading the final context throws', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'google-export-cleanup-'))
    const file = path.join(dir, 'report.csv')
    try {
      writeFileSync(file, 'synthetic fixture')
      const get = vi.fn().mockResolvedValueOnce(context).mockRejectedValueOnce(new Error('panel closed'))
      const d = driver({ context: get, armDownload: () => ({ started: () => true, done: Promise.resolve(file), cancel: () => undefined }) })
      expect(await runGoogleReportExport(url, d)).toMatchObject({ ok: false, error: 'download-failed' })
      expect(existsSync(file)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('removes a download that completes just before an early export failure', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'google-export-cleanup-race-'))
    const file = path.join(dir, 'report.csv')
    try {
      writeFileSync(file, 'synthetic fixture')
      const click = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      const d = driver({ click, armDownload: () => ({ started: () => false, done: Promise.resolve(file), cancel: () => undefined }) })
      expect(await runGoogleReportExport(url, d)).toMatchObject({ ok: false, error: 'csv-option-not-found' })
      await Promise.resolve()
      expect(existsSync(file)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('rejects credential query strings', () => {
    expect(validGoogleReportUrl(url + '&access_token=secret')).toBe(false)
    expect(validGoogleReportUrl(url + '&api_key=secret')).toBe(false)
  })
})
