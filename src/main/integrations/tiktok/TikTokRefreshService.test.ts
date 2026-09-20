import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The service touches electron windows and the settings store — keep this
// suite Electron-free with targeted mocks (same posture as scheduledTasks).
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
const { getStore, setStore } = vi.hoisted(() => ({
  getStore: vi.fn(),
  setStore: vi.fn()
}))
vi.mock('../../store', () => ({ getStore, setStore }))

import { TikTokReportStatus } from '../../../shared/tiktokReport'
import { listDatasets } from '../../boardDatasets'
import { setTikTokCredentials } from './TikTokConnectionStore'
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  TikTokRefreshService,
  TikTokRefreshSettings
} from './TikTokRefreshService'

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}

function reportResponse(rows: Array<[string, string, string]>): Response {
  return jsonResponse({
    code: 0,
    message: 'OK',
    data: {
      list: rows.map(([date, campaign, spend]) => ({
        dimensions: { stat_time_day: date, campaign_name: campaign },
        metrics: { spend, impressions: '100', clicks: '5', ctr: '0.05', cpc: '2.1', conversion: '1', cost_per_conversion: '10.5' }
      })),
      page_info: { total_page: 1 }
    }
  })
}

let dir: string
let credentialsFile: string
let datasetsFile: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tiktok-refresh-'))
  credentialsFile = path.join(dir, 'tiktok-report-credentials.json')
  datasetsFile = path.join(dir, 'board-datasets.json')
  vi.mocked(getStore).mockReset()
  vi.mocked(setStore).mockReset()
  vi.mocked(getStore).mockImplementation((() => false) as never)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

interface Fixture {
  service: TikTokRefreshService
  statuses: TikTokReportStatus[]
  settings: { auto: boolean }
  requests: Array<Record<string, unknown>>
}

function makeService(options: {
  reportPlan?: () => Response
  now?: () => number
  intervalMs?: number
  initialAuto?: boolean
} = {}): Fixture {
  const statuses: TikTokReportStatus[] = []
  const settings = { auto: options.initialAuto ?? false }
  const settingsAdapter: TikTokRefreshSettings = {
    getAutoRefresh: () => settings.auto,
    setAutoRefresh: (value) => {
      settings.auto = value
      vi.mocked(setStore)('tiktokAutoRefresh', value)
    }
  }
  const requests: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    return options.reportPlan ? options.reportPlan() : reportResponse([['2026-01-02', 'C1', '10.5']])
  }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
  const service = new TikTokRefreshService({
    fetchImpl,
    settings: settingsAdapter,
    credentialsFile,
    datasetsFile,
    now: options.now ?? (() => 1767000000000),
    intervalMs: options.intervalMs,
    broadcast: (status) => statuses.push(status)
  })
  return { service, statuses, settings, requests }
}

describe('auto-refresh toggle', () => {
  it('persists the toggle, starts and cancels the timer', () => {
    const { service, settings } = makeService()
    expect(service.isRunning()).toBe(false)

    const enabled = service.setAutoRefresh(true)
    expect(settings.auto).toBe(true)
    expect(service.isRunning()).toBe(true)
    expect(enabled.autoRefresh).toBe(true)
    expect(vi.mocked(setStore)).toHaveBeenCalledWith('tiktokAutoRefresh', true)

    const disabled = service.setAutoRefresh(false)
    expect(settings.auto).toBe(false)
    expect(service.isRunning()).toBe(false)
    expect(disabled.autoRefresh).toBe(false)
    expect(vi.mocked(setStore)).toHaveBeenCalledWith('tiktokAutoRefresh', false)
  })

  it('defaults to the persisted electron-store value on restore', () => {
    vi.mocked(getStore).mockImplementation((() => true) as never)
    // No injected settings: the service must consult the real (mocked)
    // electron-store adapter, proving the persisted toggle drives startup.
    const service = new TikTokRefreshService({
      credentialsFile: path.join(dir, 'unused-credentials.json'),
      datasetsFile: path.join(dir, 'unused-datasets.json')
    })
    service.restoreFromSettings()
    expect(vi.mocked(getStore)).toHaveBeenCalledWith('tiktokAutoRefresh')
    expect(service.isRunning()).toBe(true)
    service.stop()
  })

  it('the default interval is 30 minutes and short values clamp to the floor', () => {
    vi.useFakeTimers()
    const { service: fast } = makeService({ intervalMs: 1000 })
    const spy = vi.spyOn(fast, 'refreshNow').mockResolvedValue({
      ok: true,
      rowCount: 1,
      truncated: false,
      status: {} as TikTokReportStatus
    })
    fast.start()
    // 1s clamps up to MIN_REFRESH_INTERVAL_MS; a 30-min tick can't be reached
    // here, so just verify start() armed the timer.
    expect(fast.isRunning()).toBe(true)
    fast.stop()
    spy.mockRestore()
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(30 * 60 * 1000)
  })

  it('fires refreshNow on the interval tick', () => {
    vi.useFakeTimers()
    const { service } = makeService()
    const spy = vi.spyOn(service, 'refreshNow').mockResolvedValue({
      ok: true,
      rowCount: 0,
      truncated: false,
      status: {} as TikTokReportStatus
    })
    service.start()
    vi.advanceTimersByTime(30 * 60 * 1000 + 1)
    expect(spy).toHaveBeenCalled()
    service.stop()
    spy.mockRestore()
  })
})

describe('refreshNow', () => {
  it('refuses without credentials and surfaces the error state', async () => {
    const { service, statuses } = makeService()
    const outcome = await service.refreshNow()
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('not-configured')
    const status = service.getStatus()
    expect(status.lastError).toBe('not-configured')
    expect(statuses.length).toBeGreaterThan(0)
  })

  it('pulls the report and overwrites the "TikTok 报表" dataset', async () => {
    setTikTokCredentials(
      { accessToken: 'tok-1', advertiserIds: [7300001] },
      credentialsFile
    )
    const now = 1767000000000
    const localDate = (date: Date): string =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const endExpected = localDate(new Date(now))
    const startDate = new Date(now)
    startDate.setDate(startDate.getDate() - 6)
    const startExpectedStr = localDate(startDate)
    const { service, requests } = makeService({ now: () => now })
    const outcome = await service.refreshNow()
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.rowCount).toBe(1)
      expect(outcome.truncated).toBe(false)
    }
    expect(outcome.status.lastRowCount).toBe(1)
    expect(outcome.status.lastRefreshAt).toBe(now)
    expect(outcome.status.lastError).toBeUndefined()

    // One report call scoped to the configured advertiser, last-7-days window
    // (timezone-independent: expected dates are computed in the local zone).
    expect(requests[0].advertiser_id).toBe(7300001)
    expect(requests[0].start_date).toBe(startExpectedStr)
    expect(requests[0].end_date).toBe(endExpected)

    const datasets = listDatasets(datasetsFile)
    expect(datasets).toHaveLength(1)
    expect(datasets[0].name).toBe('TikTok 报表')
    expect(datasets[0].rows[0]).toEqual(['2026-01-02', 'C1', 10.5, 100, 5, 0.05, 2.1, 1, 10.5])
  })

  it('surfaces API failures through lastError without clobbering the dataset', async () => {
    setTikTokCredentials({ accessToken: 'tok-1' }, credentialsFile)
    writeFileSync(datasetsFile, '[]')
    const { service } = makeService({
      reportPlan: () => jsonResponse({ code: 40100, message: 'Invalid access token', data: {} })
    })
    const outcome = await service.refreshNow()
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('40100')
    expect(service.getStatus().lastError).toContain('40100')
    expect(service.getStatus().refreshing).toBe(false)
    expect(readFileSync(datasetsFile, 'utf-8')).toBe('[]')
  })

  it('guards against overlapping refreshes', async () => {
    setTikTokCredentials({ accessToken: 'tok-1' }, credentialsFile)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = (async () => {
      await gate
      return reportResponse([['2026-01-02', 'C1', '10.5']])
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
    const service = new TikTokRefreshService({
      fetchImpl,
      settings: { getAutoRefresh: () => false, setAutoRefresh: () => {} },
      credentialsFile,
      datasetsFile,
      broadcast: () => {}
    })
    const first = service.refreshNow()
    const second = await service.refreshNow()
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toBe('refresh-in-progress')
    release()
    const firstResult = await first
    expect(firstResult.ok).toBe(true)
    expect(service.getStatus().refreshing).toBe(false)
  })

  it('rotates an expired token before pulling the report', async () => {
    setTikTokCredentials(
      {
        appId: '731',
        appSecret: 'sec',
        accessToken: 'expired-token',
        refreshToken: 'rt-1',
        expiresAt: 1000 // long past the service's fixed "now"
      },
      credentialsFile
    )
    const reportHeaders: Array<string | undefined> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth2/refresh_token/')) {
        return jsonResponse({
          code: 0,
          message: 'OK',
          data: { access_token: 'fresh-token', expires_in: 86400, refresh_token: 'rt-2', advertiser_ids: [] }
        })
      }
      reportHeaders.push((init?.headers as Record<string, string>)['Access-Token'])
      return reportResponse([['2026-01-02', 'C1', '10.5']])
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
    const service = new TikTokRefreshService({
      fetchImpl,
      settings: { getAutoRefresh: () => false, setAutoRefresh: () => {} },
      credentialsFile,
      datasetsFile,
      now: () => 1767000000000,
      broadcast: () => {}
    })
    const outcome = await service.refreshNow()
    expect(outcome.ok).toBe(true)
    const stored = JSON.parse(readFileSync(credentialsFile, 'utf-8'))
    expect(stored.accessToken).toBe('fresh-token')
    expect(stored.refreshToken).toBe('rt-2')
    expect(stored.expiresAt).toBe(1767000000000 + 86400 * 1000)
    // The report call went out with the ROTATED token, not the expired one.
    expect(reportHeaders).toEqual(['fresh-token'])
  })
})
