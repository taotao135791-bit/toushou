import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  windows: [] as Array<{ isDestroyed: () => boolean; setBackgroundColor: (color: string) => void; destroyed?: boolean }>,
  themeSource: 'system' as string
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => state.windows
  },
  nativeTheme: {
    get themeSource() { return state.themeSource },
    set themeSource(value: string) { state.themeSource = value }
  }
}))

import { applyWindowTheme, themeBackgroundColor } from '../windowTheme'

describe('windowTheme (macOS-visible backdrop + native chrome)', () => {
  beforeEach(() => {
    state.windows = []
    state.themeSource = 'system'
  })

  it('maps the CSS --bg-app values for both themes', () => {
    expect(themeBackgroundColor('dark')).toBe('#1b1b1b')
    expect(themeBackgroundColor('light')).toBe('#faf9f8')
    // Unknown values must degrade to light, never a blank backdrop.
    expect(themeBackgroundColor(undefined)).toBe('#faf9f8')
    expect(themeBackgroundColor('sepia')).toBe('#faf9f8')
  })

  it('repaints every live window and flips native chrome to match', () => {
    const calls: string[] = []
    state.windows = [
      { isDestroyed: () => false, setBackgroundColor: (color) => calls.push(color) },
      { isDestroyed: () => false, setBackgroundColor: (color) => calls.push(color) }
    ]
    applyWindowTheme('dark')
    expect(calls).toEqual(['#1b1b1b', '#1b1b1b'])
    expect(state.themeSource).toBe('dark')
    applyWindowTheme('light')
    expect(calls).toEqual(['#1b1b1b', '#1b1b1b', '#faf9f8', '#faf9f8'])
    expect(state.themeSource).toBe('light')
  })

  it('skips destroyed windows and survives a throwing window (closing race)', () => {
    state.windows = [
      { isDestroyed: () => true, setBackgroundColor: () => { throw new Error('should not be called') } },
      { isDestroyed: () => false, setBackgroundColor: () => { throw new Error('closing') } },
      { isDestroyed: () => false, setBackgroundColor: () => {} }
    ]
    expect(() => applyWindowTheme('dark')).not.toThrow()
  })
})
