import { afterEach, describe, expect, it, vi } from 'vitest'
import { getActiveBrowserPanel, loadBrowserPanelUrl } from '../browserPanel'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../browserPanel', () => ({
  getActiveBrowserPanel: vi.fn(),
  isBrowserPanelVisible: () => true,
  loadBrowserPanelUrl: vi.fn(async () => {}),
  withBrowserReadingViewport: (_view: unknown, read: () => Promise<unknown>) => read()
}))
import {
  gateBrowserUseRequest,
  isFacebookReadOnlyAction,
  parseBrowserUseRequest,
  readStableFbReading,
  refreshBoardFbReading,
  SCROLL_SCRIPT,
  SNAPSHOT_SCRIPT,
  FB_ADS_TABLE_SNAPSHOT_SCRIPT,
  collectVirtualizedFbPages,
  CLICK_GROUP_ROW_SCRIPT,
  FIND_GROUP_ROWS_SCRIPT,
  type FbReadOnce
} from '../browserUse'
import { parseFbAdsCampaignsSnapshot } from '../../shared/fbAdsParser'
import { REAL_CAMPAIGNS_TEXT, REAL_URL } from '../../shared/fbAdsParser.test'

describe('account switcher portfolio row scripts', () => {
  it('keeps repeated numeric portfolio counts distinct and clicks the matching occurrence', () => {
    const makeRow = (text: string) => ({
      innerText: text,
      textContent: text,
      childElementCount: 0,
      contains: () => false,
      click: vi.fn()
    })
    const rows = [makeRow('10 ad accounts'), makeRow('10 ad accounts')]
    const menu = {
      innerText: 'Business portfolios · 10 ad accounts · 10 ad accounts',
      childElementCount: rows.length,
      contains: (node: unknown) => rows.includes(node as typeof rows[number]),
      querySelectorAll: () => rows
    }
    const document = { querySelectorAll: () => [menu] }
    const found = new Function('document', 'return ' + FIND_GROUP_ROWS_SCRIPT)(document) as {
      named: string[]
      counts: string[]
      truncated: boolean
    }

    expect(found).toEqual({ named: [], counts: ['10#0', '10#1'], truncated: false })
    expect(new Function('document', 'return ' + CLICK_GROUP_ROW_SCRIPT('10#1', false))(document)).toBe(true)
    expect(rows[0].click).not.toHaveBeenCalled()
    expect(rows[1].click).toHaveBeenCalledOnce()
  })
})

describe('board refresh admission and failures', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  const prepare = () => {
    vi.useFakeTimers()
    const executeJavaScript = vi.fn(async () => ({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns',
      title: 'Ads Manager',
      text: '错误：组件加载失败'
    }))
    vi.mocked(getActiveBrowserPanel).mockReturnValue({ webContents: {
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => 'https://adsmanager.facebook.com/adsmanager/manage/campaigns',
      getTitle: () => 'Ads Manager',
      reload: vi.fn(),
      executeJavaScript
    } } as unknown as NonNullable<ReturnType<typeof getActiveBrowserPanel>>)
    return executeJavaScript
  }

  it('joins repeated clicks and refuses a different refresh while the panel is in use', async () => {
    const execute = prepare()
    const ref = { alias: '三国IOS', act: '2131017261144314', businessId: '1734414010144999' }
    const first = refreshBoardFbReading(ref, 'last3')
    expect(refreshBoardFbReading(ref, 'last3')).toBe(first)
    expect(await refreshBoardFbReading(ref, 'last7')).toEqual({ ok: false, error: 'browser-busy' })
    await vi.advanceTimersByTimeAsync(300)
    expect(await first).toEqual({ ok: false, error: 'page-load-failed' })
    expect(loadBrowserPanelUrl).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    const retry = refreshBoardFbReading(ref, 'last3')
    await vi.advanceTimersByTimeAsync(300)
    expect(await retry).toEqual({ ok: false, error: 'page-load-failed' })
    expect(loadBrowserPanelUrl).toHaveBeenCalledTimes(2)
  })

  it('returns a network failure without attempting a report or background retries', async () => {
    const execute = prepare()
    vi.mocked(loadBrowserPanelUrl).mockRejectedValueOnce(new Error('ERR_NETWORK_CHANGED (-21) loading private URL'))
    const result = refreshBoardFbReading(
      { alias: '三国IOS', act: '2131017261144314', businessId: '1734414010144999' },
      'last3'
    )
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toEqual({ ok: false, error: 'ERR_NETWORK_CHANGED' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(loadBrowserPanelUrl).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports login-required when the mid-read page bounces to a login wall and does not reload-retry', async () => {
    vi.useFakeTimers()
    const execute = vi.fn(async () => ({
      url: 'https://business.facebook.com/business/loginpage',
      title: 'Log in to Facebook',
      text: 'Meta Business Suite'
    }))
    const reload = vi.fn()
    vi.mocked(getActiveBrowserPanel).mockReturnValue({ webContents: {
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => 'https://adsmanager.facebook.com/adsmanager/manage/campaigns',
      getTitle: () => 'Ads Manager',
      reload,
      executeJavaScript: execute
    } } as unknown as NonNullable<ReturnType<typeof getActiveBrowserPanel>>)
    const result = refreshBoardFbReading(
      { alias: '三国IOS', act: '2131017261144314', businessId: '1734414010144999' },
      'last3'
    )
    await vi.advanceTimersByTimeAsync(35_000)
    expect(await result).toEqual({ ok: false, error: 'login-required' })
    expect(loadBrowserPanelUrl).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('fails fast on the first unverified read instead of reload-retrying inside Main', async () => {
    vi.useFakeTimers()
    // Parses to nothing on the first pass. iOS-style virtualized tables
    // need one stretch+reload inside Main; a second unparseable-page still
    // fails without a third round.
    const execute = vi.fn(async () => ({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns',
      title: 'Ads Manager',
      text: 'Some unrelated page body without a campaign table'
    }))
    const reload = vi.fn()
    vi.mocked(getActiveBrowserPanel).mockReturnValue({ webContents: {
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => 'https://adsmanager.facebook.com/adsmanager/manage/campaigns',
      getTitle: () => 'Ads Manager',
      reload,
      executeJavaScript: execute
    } } as unknown as NonNullable<ReturnType<typeof getActiveBrowserPanel>>)
    const result = refreshBoardFbReading(
      { alias: '三国IOS', act: '2131017261144314', businessId: '1734414010144999' },
      'last3'
    )
    await vi.advanceTimersByTimeAsync(70_000)
    expect(await result).toEqual({ ok: false, error: 'unparseable-page' })
    expect(execute.mock.calls.length).toBeGreaterThan(0)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(loadBrowserPanelUrl).toHaveBeenCalledTimes(1)
  })
})

describe('isFacebookReadOnlyAction (hard FB read-only boundary)', () => {
  it('blocks click and type on any facebook.com surface', () => {
    for (const url of [
      'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1',
      'https://business.facebook.com/latest/home',
      'https://www.facebook.com/'
    ]) {
      expect(isFacebookReadOnlyAction('click', url)).toBe(true)
      expect(isFacebookReadOnlyAction('type', url)).toBe(true)
    }
  })

  it('allows reading actions on facebook and everything elsewhere', () => {
    for (const action of ['navigate', 'snapshot', 'screenshot', 'scroll', 'back', 'forward', 'wait'] as const) {
      expect(isFacebookReadOnlyAction(action, 'https://adsmanager.facebook.com/')).toBe(false)
    }
    expect(isFacebookReadOnlyAction('click', 'https://example.com/')).toBe(false)
    expect(isFacebookReadOnlyAction('type', 'https://adsmanager.facebook.com.evil.com/')).toBe(false)
    expect(isFacebookReadOnlyAction('click', null)).toBe(false)
  })
})

describe('gateBrowserUseRequest', () => {
  it('requires explicit takeover before another session can navigate', () => {
    expect(gateBrowserUseRequest('navigate', 'B', 'A', false)).toBe('panel-owned-by-another-session')
    expect(gateBrowserUseRequest('navigate', 'B', 'A', false, true)).toBeNull()
    expect(gateBrowserUseRequest('navigate', 'A', null, true)).toBeNull()
  })

  it('always admits history (local verified store, never touches the panel)', () => {
    expect(gateBrowserUseRequest('history', 'B', 'A', false)).toBeNull()
    expect(gateBrowserUseRequest('history', 'A', null, true)).toBeNull()
  })

  it('refuses every other action while the panel is hidden', () => {
    for (const action of ['snapshot', 'report', 'click', 'type', 'scroll', 'screenshot', 'back', 'forward', 'wait'] as const) {
      expect(gateBrowserUseRequest(action, 'A', 'A', false)).toBe('panel-hidden')
    }
  })

  it('refuses non-navigate actions from a session that does not own the panel', () => {
    expect(gateBrowserUseRequest('click', 'B', 'A', true)).toBe('panel-owned-by-another-session')
    expect(gateBrowserUseRequest('snapshot', 'A', 'B', true)).toBe('panel-owned-by-another-session')
  })

  it('admits the owner and unowned panels', () => {
    expect(gateBrowserUseRequest('click', 'A', 'A', true)).toBeNull()
    expect(gateBrowserUseRequest('snapshot', 'A', null, true)).toBeNull()
  })
})

describe('parseBrowserUseRequest', () => {
  it('does not expose password values in the DOM snapshot projection', () => {
    expect(SNAPSHOT_SCRIPT).toContain("type === 'password' ? undefined")
    expect(SNAPSHOT_SCRIPT).toContain('safeValue !== undefined')
  })

  it('accepts a valid navigate', () => {
    expect(parseBrowserUseRequest({ action: 'navigate', url: 'https://example.com' })).toEqual({
      action: 'navigate',
      url: 'https://example.com'
    })
  })

  it('rejects navigate without a url', () => {
    expect(parseBrowserUseRequest({ action: 'navigate' })).toBeNull()
    expect(parseBrowserUseRequest({ action: 'navigate', url: '' })).toBeNull()
  })

  it('accepts snapshot, screenshot, back and forward without params', () => {
    expect(parseBrowserUseRequest({ action: 'snapshot' })).toEqual({ action: 'snapshot' })
    expect(parseBrowserUseRequest({ action: 'report' })).toEqual({ action: 'report' })
    expect(parseBrowserUseRequest({ action: 'screenshot' })).toEqual({ action: 'screenshot' })
    expect(parseBrowserUseRequest({ action: 'back' })).toEqual({ action: 'back' })
    expect(parseBrowserUseRequest({ action: 'forward' })).toEqual({ action: 'forward' })
  })

  it('accepts history with a bounded account id and limit', () => {
    expect(parseBrowserUseRequest({ action: 'history' })).toEqual({ action: 'history', accountId: undefined, limit: 10 })
    expect(parseBrowserUseRequest({ action: 'history', accountId: '2131017261144314', limit: 20 })).toEqual({
      action: 'history',
      accountId: '2131017261144314',
      limit: 20
    })
    expect(parseBrowserUseRequest({ action: 'history', accountId: 'abc', limit: 999 })).toEqual({
      action: 'history',
      accountId: undefined,
      limit: 10
    })
  })

  it('accepts click with a bounded integer ref', () => {
    expect(parseBrowserUseRequest({ action: 'click', ref: 3 })).toBeNull()
    expect(parseBrowserUseRequest({ action: 'click', ref: 3, snapshotId: 'snap-1' })).toEqual({ action: 'click', ref: 3, snapshotId: 'snap-1' })
    expect(parseBrowserUseRequest({ action: 'click', ref: 0 })).toBeNull()
    expect(parseBrowserUseRequest({ action: 'click', ref: 2.5 })).toBeNull()
    expect(parseBrowserUseRequest({ action: 'click', ref: '3' })).toBeNull()
  })

  it('carries snapshot provenance for input actions when provided', () => {
    expect(parseBrowserUseRequest({ action: 'click', ref: 3, snapshotId: 'snap-1' })).toEqual({
      action: 'click', ref: 3, snapshotId: 'snap-1'
    })
    expect(parseBrowserUseRequest({ action: 'type', ref: 2, text: 'hello', snapshotId: 'snap-1' })).toEqual({
      action: 'type', ref: 2, text: 'hello', submit: false, snapshotId: 'snap-1'
    })
  })

  it('accepts type with ref and text, submit optional', () => {
    expect(parseBrowserUseRequest({ action: 'type', ref: 2, text: 'hello' })).toBeNull()
    expect(parseBrowserUseRequest({ action: 'type', ref: 2, text: 'hi', submit: true, snapshotId: 'snap-1' })).toEqual({
      action: 'type',
      ref: 2,
      text: 'hi',
      submit: true,
      snapshotId: 'snap-1'
    })
    expect(parseBrowserUseRequest({ action: 'type', ref: 2 })).toBeNull()
  })

  it('clamps scroll amount and direction', () => {
    expect(parseBrowserUseRequest({ action: 'scroll', direction: 'down' })).toEqual({
      action: 'scroll',
      direction: 'down',
      amount: 600
    })
    expect(
      parseBrowserUseRequest({ action: 'scroll', direction: 'down', amount: 99999 })
    ).toEqual({ action: 'scroll', direction: 'down', amount: 4000 })
    expect(parseBrowserUseRequest({ action: 'scroll', direction: 'sideways' })).toBeNull()
  })

  it('clamps wait milliseconds', () => {
    expect(parseBrowserUseRequest({ action: 'wait', ms: 300 })).toEqual({ action: 'wait', ms: 300 })
    expect(parseBrowserUseRequest({ action: 'wait', ms: 999999 })).toEqual({
      action: 'wait',
      ms: 5000
    })
    expect(parseBrowserUseRequest({ action: 'wait' })).toEqual({ action: 'wait', ms: 1000 })
  })

  it('rejects unknown actions and non-object bodies', () => {
    expect(parseBrowserUseRequest({ action: 'eval', code: 'process.exit()' })).toBeNull()
    expect(parseBrowserUseRequest('navigate')).toBeNull()
    expect(parseBrowserUseRequest(null)).toBeNull()
  })
})

describe('SCROLL_SCRIPT', () => {
  it('scrolls the main frame and the roomiest inner scrollable container', () => {
    const script = SCROLL_SCRIPT(-800)
    expect(script).toContain("window.scrollBy({ top: delta })")
    expect(script).toContain("-800")
    // The inner-container scan is what rescues Ads Manager tables: their rows
    // virtualize inside a nested scroller the window never moves.
    expect(script).toContain("overflowY === 'auto' || style.overflowY === 'scroll'")
    expect(script).toContain('best.scrollBy({ top: delta })')
    expect(script).toContain('after !== before')
    expect(script).toContain('el.clientHeight < 80 || room <= 4')
  })
})

describe('FB_ADS_TABLE_SNAPSHOT_SCRIPT', () => {
  const runSnapshot = (doc: unknown, url = REAL_URL) => {
    const source = FB_ADS_TABLE_SNAPSHOT_SCRIPT.replace(/${MAX_TEXT_CHARS}/g, '20000')
    return new Function('document', 'location', 'return ' + source)(doc, { href: url }) as { text: string }
  }

  it('rebuilds one table when frozen campaign names have no innerText', () => {
    const names = REAL_CAMPAIGNS_TEXT.split('\n').filter((line) => line.startsWith('adtiger_'))
    const namelessPage = names.reduce((text, name) => text.replace(name + '\n', ''), REAL_CAMPAIGNS_TEXT)
    const headerCells = ['关/开', '广告系列', '已花费金额', '单次应用安装费用', 'CPM（千次展示费用）', '成效', '点击量（全部）', '点击率（全部）', '单次点击费用（全部）', '应用安装量', '移动应用安装量', '投放', '操作', '归因设置', '单次成效费用', '预算', '定制列...']
    const rows = [
      { cells: headerCells.map((text) => ({ innerText: text, textContent: text })) },
      ...names.map((name) => {
        const start = REAL_CAMPAIGNS_TEXT.indexOf(name)
        const later = names.map((other) => REAL_CAMPAIGNS_TEXT.indexOf(other)).filter((idx) => idx > start)
        const next = later.length > 0 ? Math.min(...later) : REAL_CAMPAIGNS_TEXT.indexOf('8个广告系列的成效')
        const values = REAL_CAMPAIGNS_TEXT.slice(start, next).split('\n').slice(1).filter(Boolean)
        return {
          cells: [
            { innerText: '', textContent: name },
            ...values.map((value) => ({ innerText: value, textContent: value }))
          ]
        }
      }),
      { cells: [{ innerText: '8个广告系列的成效', textContent: '8个广告系列的成效' }, { innerText: '$3,146.47', textContent: '$3,146.47' }, { innerText: '总花费', textContent: '总花费' }] }
    ]
    const snapshot = runSnapshot({
      querySelector: () => ({ innerText: namelessPage }),
      querySelectorAll: (selector: string) => {
        if (selector === '[role="row"]') {
          return rows.map((row) => ({
            querySelectorAll: () => row.cells,
            innerText: row.cells.map((cell) => cell.innerText).filter(Boolean).join('\n'),
            textContent: row.cells.map((cell) => cell.textContent).join('\n')
          }))
        }
        return []
      },
      title: 'Ads Manager'
    })
    const parsed = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: snapshot.text })
    expect(parsed?.rows).toHaveLength(8)
    expect(parsed?.rows.map((row) => row.name)).toEqual(names)
  })
})

describe('collectVirtualizedFbPages', () => {
  const page = (names: string[], count = 13): FbReadOnce<{ campaignCount: number | null; rows: Array<{ name: string }> }> => ({
    url: REAL_URL,
    title: 'Ads Manager',
    text: names.join('\n'),
    reading: { campaignCount: count, rows: names.map((name) => ({ name })) }
  })

  it('starts from the provided top seed and uses the first real clientHeight as the step', async () => {
    const deltas: number[] = []
    const result = await collectVirtualizedFbPages(page(['camp_01', 'camp_02', 'camp_03']), {
      readOnce: async () => page(['camp_04', 'camp_05', 'camp_06', 'camp_07', 'camp_08', 'camp_09', 'camp_10', 'camp_11', 'camp_12', 'camp_13']),
      scroll: async (delta) => {
        deltas.push(delta)
        return { moved: delta !== 0, client: 500, room: 1800 }
      },
      sleep: async () => undefined
    })
    expect(deltas[0]).toBe(0)
    expect(deltas.slice(1).every((delta) => delta === 400)).toBe(true)
    expect(new Set(result.parts.flatMap((part) => part.rows.map((row) => row.name))).size).toBe(13)
  })

  it('does not scroll when no container reports usable room', async () => {
    let reads = 0
    const result = await collectVirtualizedFbPages(page(['camp_01']), {
      readOnce: async () => {
        reads += 1
        return page(['camp_02'])
      },
      scroll: async () => ({ moved: false, client: 0, room: 0 }),
      sleep: async () => undefined
    })
    expect(reads).toBe(0)
    expect(result.parts).toHaveLength(1)
  })

  it('stops the current pass on a mid-scan login wall', async () => {
    const result = await collectVirtualizedFbPages(page(['camp_01']), {
      readOnce: async () => ({
        url: 'https://business.facebook.com/business/loginpage',
        title: 'Log in',
        text: 'Meta Business Suite',
        reading: null
      }),
      scroll: async () => ({ moved: true, client: 400, room: 1200 }),
      sleep: async () => undefined,
      isTerminal: (snap) => snap.url.includes('loginpage')
    })
    expect(result.stop?.url).toContain('loginpage')
    expect(result.parts).toHaveLength(1)
  })
})

describe('readStableFbReading (progressive-render retry)', () => {
  const fast = { delayMs: 1, settleDelayMs: 1 }
  const noRejection = () => null
  const incomplete = () => 'incomplete-view'

  const read = (reading: object | null): FbReadOnce<unknown> => ({
    url: 'https://adsmanager.facebook.com/x',
    title: 't',
    text: 'raw',
    reading
  })

  it('stops immediately on Facebook component failure instead of rereading a terminal error for 30 seconds', async () => {
    let calls = 0
    const result = await readStableFbReading(async () => {
      calls += 1
      return { ...read(null), text: '错误：组件加载失败\n出错了，请重新加载页面。' }
    }, noRejection, fast)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('page-load-failed')
    expect(calls).toBe(1)
  })

  it('also stops when the settled second read becomes a component error', async () => {
    let calls = 0
    const result = await readStableFbReading(async () => {
      calls += 1
      return calls === 1 ? read({ ok: true }) : { ...read(null), text: '错误：组件加载失败' }
    }, noRejection, fast)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('page-load-failed')
    expect(calls).toBe(2)
  })

  it('retries past a transient incomplete-view and returns two stable reads', async () => {
    const good = { campaignCount: 8 }
    const reads = [read(null), read({ broken: true }), read(good), read(good)]
    let calls = 0
    const result = await readStableFbReading(
      async () => reads[calls++],
      (r) => ((r as { broken?: boolean }).broken ? incomplete() : noRejection()),
      { ...fast, firstAttempts: 4, secondAttempts: 2 }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.first.reading).toEqual(good)
      expect(result.second.reading).toEqual(good)
    }
    expect(calls).toBe(4)
  })

  it('refuses with the precise gate code when the first read never passes', async () => {
    const bad = { campaignCount: 8, rows: 3 }
    let calls = 0
    const result = await readStableFbReading(
      async () => { calls += 1; return read(bad) },
      incomplete,
      { ...fast, firstAttempts: 3 }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('incomplete-view')
      expect(result.last.reading).toEqual(bad)
    }
    expect(calls).toBe(3)
  })

  it('refuses with unparseable-page when nothing ever parses', async () => {
    const result = await readStableFbReading(async () => read(null), noRejection, { ...fast, firstAttempts: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('unparseable-page')
  })

  it('gives the settled second read its own bounded retries', async () => {
    const good = { ok: true }
    const reads = [read(good), read({ wobble: true }), read({ wobble: true }), read(good)]
    let calls = 0
    const result = await readStableFbReading(
      async () => reads[calls++],
      (r) => ((r as { wobble?: boolean }).wobble ? incomplete() : noRejection()),
      { ...fast, firstAttempts: 2, secondAttempts: 3 }
    )
    expect(result.ok).toBe(true)
    expect(calls).toBe(4)
  })

  it('refuses with the gate code when the second read stays unstable', async () => {
    const good = { ok: 1 }
    const reads = [read(good), read({ late: true }), read({ late: true })]
    let calls = 0
    const result = await readStableFbReading(
      async () => reads[calls++],
      (r) => ((r as { late?: boolean }).late ? 'totals-mismatch' : noRejection()),
      { ...fast, firstAttempts: 1, secondAttempts: 2 }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('totals-mismatch')
  })

  it('refuses with unstable-page when the second read stops parsing', async () => {
    const good = { ok: 1 }
    const reads = [read(good), read(null), read(null)]
    let calls = 0
    const result = await readStableFbReading(
      async () => reads[calls++],
      noRejection,
      { ...fast, firstAttempts: 1, secondAttempts: 2 }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('unstable-page')
  })
})
