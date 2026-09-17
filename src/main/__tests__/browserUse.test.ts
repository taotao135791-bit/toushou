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
  type FbReadOnce
} from '../browserUse'

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
      executeJavaScript
    } } as unknown as NonNullable<ReturnType<typeof getActiveBrowserPanel>>)
    return executeJavaScript
  }

  it('joins repeated clicks and refuses a different refresh while the panel is in use', async () => {
    const execute = prepare()
    const first = refreshBoardFbReading('三国IOS', 'last3')
    expect(refreshBoardFbReading('三国IOS', 'last3')).toBe(first)
    expect(await refreshBoardFbReading('三国IOS', 'last7')).toEqual({ ok: false, error: 'browser-busy' })
    await vi.advanceTimersByTimeAsync(300)
    expect(await first).toEqual({ ok: false, error: 'page-load-failed' })
    expect(loadBrowserPanelUrl).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    const retry = refreshBoardFbReading('三国IOS', 'last3')
    await vi.advanceTimersByTimeAsync(300)
    expect(await retry).toEqual({ ok: false, error: 'page-load-failed' })
    expect(loadBrowserPanelUrl).toHaveBeenCalledTimes(2)
  })

  it('returns a network failure without attempting a report or background retries', async () => {
    const execute = prepare()
    vi.mocked(loadBrowserPanelUrl).mockRejectedValueOnce(new Error('ERR_NETWORK_CHANGED (-21) loading private URL'))
    const result = refreshBoardFbReading('三国IOS', 'last3')
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toEqual({ ok: false, error: 'ERR_NETWORK_CHANGED' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(loadBrowserPanelUrl).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
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
    expect(script).toContain('window.scrollBy({ top: delta })')
    expect(script).toContain("-800")
    // The inner-container scan is what rescues Ads Manager tables: their rows
    // virtualize inside a nested scroller the window never moves.
    expect(script).toContain("overflowY === 'auto' || style.overflowY === 'scroll'")
    expect(script).toContain('best.scrollBy({ top: delta })')
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
