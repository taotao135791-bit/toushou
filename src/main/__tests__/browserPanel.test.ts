import { describe, it, expect, vi } from 'vitest'

// browserPanel.ts owns real Electron views; only its pure validators are
// tested here, so electron is stubbed away.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  shell: { openExternal: vi.fn() }
}))

import { BROWSER_PANEL_BOUNDS_LIMIT, sanitizeBrowserPanelBounds } from '../browserPanel'

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
