import { describe, it, expect, vi, afterEach } from 'vitest'
import { BrowserWindow, type WebContents, type WebContentsView } from 'electron'

// browserPanel.ts owns real Electron views; only its pure validators are
// tested here, so electron is stubbed away.
vi.mock('electron', () => ({
  BrowserWindow: class {
    static fromWebContents = vi.fn(() => null)
  },
  WebContentsView: class {},
  shell: { openExternal: vi.fn() }
}))

import {
  BROWSER_PANEL_BOUNDS_LIMIT,
  BROWSER_PANEL_PARTITION,
  plainChromeUserAgent,
  sanitizeBrowserPanelBounds,
  loadBrowserPanelUrl,
  withBrowserReadingViewport
} from '../browserPanel'

describe('panel navigation and report layout', () => {
  afterEach(() => vi.useRealTimers())
  const page = () => ({
    getURL: vi.fn(() => 'https://example.com/old'),
    isLoading: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    stop: vi.fn(),
    loadURL: vi.fn(async (_url: string) => {})
  })

  it('joins renderer and Main navigation while getURL still points at the old document', async () => {
    const wc = page()
    let finish!: () => void
    wc.loadURL.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const first = loadBrowserPanelUrl(wc as unknown as WebContents, 'https://example.com/?date=a,b', true)
    const second = loadBrowserPanelUrl(wc as unknown as WebContents, 'https://example.com/?date=a%2Cb')
    await Promise.resolve()
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    finish()
    await first
  })

  it('surfaces network failure and permits an explicit retry', async () => {
    const wc = page()
    wc.loadURL.mockRejectedValueOnce(new Error('ERR_NETWORK_CHANGED'))
    await expect(loadBrowserPanelUrl(wc as unknown as WebContents, 'https://example.com/new')).rejects.toThrow('ERR_NETWORK_CHANGED')
    await loadBrowserPanelUrl(wc as unknown as WebContents, 'https://example.com/new', true)
    expect(wc.loadURL).toHaveBeenCalledTimes(2)
  })

  it('stops a hung navigation at its deadline', async () => {
    vi.useFakeTimers()
    const wc = page()
    wc.loadURL.mockImplementation(() => new Promise(() => {}))
    const result = loadBrowserPanelUrl(wc as unknown as WebContents, 'https://example.com/new').catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await result).toBe('navigation-timeout')
    expect(wc.stop).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('stretches to the window for gated reads and restores renderer bounds after success/failure (%s)', async (fail) => {
    const setBounds = vi.fn()
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({
      getContentSize: () => [1440, 900]
    } as never)
    const view = {
      getBounds: () => ({ x: 900, y: 120, width: 720, height: 700 }),
      setBounds,
      webContents: { isDestroyed: () => false }
    } as unknown as WebContentsView
    const result = withBrowserReadingViewport(view, async () => {
      expect(setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1440, height: 900 })
      if (fail) throw new Error('page-load-failed')
      return 'verified'
    })
    if (fail) await expect(result).rejects.toThrow('page-load-failed')
    else expect(await result).toBe('verified')
    expect(setBounds).toHaveBeenLastCalledWith({ x: 900, y: 120, width: 720, height: 700 })
    vi.mocked(BrowserWindow.fromWebContents).mockReset()
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null)
  })
})

describe('sanitizeBrowserPanelBounds', () => {
  it('accepts four finite non-negative bounded numbers', () => {
    expect(sanitizeBrowserPanelBounds({ x: 0, y: 42, width: 800, height: 600 })).toEqual({
      x: 0,
      y: 42,
      width: 800,
      height: 600
    })
    expect(
      sanitizeBrowserPanelBounds({
        x: BROWSER_PANEL_BOUNDS_LIMIT,
        y: 0,
        width: BROWSER_PANEL_BOUNDS_LIMIT,
        height: 1
      })
    ).toEqual({ x: BROWSER_PANEL_BOUNDS_LIMIT, y: 0, width: BROWSER_PANEL_BOUNDS_LIMIT, height: 1 })
  })

  it('rejects non-objects and missing keys', () => {
    for (const value of [null, undefined, 42, 'bounds', [], { x: 0, y: 0, width: 10 }]) {
      expect(sanitizeBrowserPanelBounds(value)).toBeNull()
    }
  })

  it('rejects negative, non-finite, oversized, and non-number fields', () => {
    const good = { x: 1, y: 2, width: 3, height: 4 }
    for (const bad of [
      { ...good, x: -1 },
      { ...good, y: Number.NaN },
      { ...good, width: Number.POSITIVE_INFINITY },
      { ...good, height: BROWSER_PANEL_BOUNDS_LIMIT + 1 },
      { ...good, x: '1' },
      { ...good, width: null }
    ]) {
      expect(sanitizeBrowserPanelBounds(bad)).toBeNull()
    }
  })
})

describe('BROWSER_PANEL_PARTITION', () => {
  it('is a persistent partition so logins survive restarts', () => {
    expect(BROWSER_PANEL_PARTITION.startsWith('persist:')).toBe(true)
  })
})

describe('plainChromeUserAgent', () => {
  it('builds a plain Chrome UA per platform with the real Chromium version', () => {
    expect(plainChromeUserAgent('darwin', '126.0.0.1')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.1 Safari/537.36'
    )
    expect(plainChromeUserAgent('win32', '126.0.0.1')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.1 Safari/537.36'
    )
    expect(plainChromeUserAgent('linux', '126.0.0.1')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.1 Safari/537.36'
    )
  })

  it('carries no Electron or app build markers', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const ua = plainChromeUserAgent(platform, '126.0.0.1')
      expect(ua).not.toMatch(/Electron|toushou|OMP|ompgui/i)
    }
  })
})
