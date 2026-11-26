import { BrowserWindow, nativeTheme } from 'electron'

/**
 * Native window backdrop per theme — must match index.css --bg-app
 * (250 249 248 light / 27 27 27 dark).
 *
 * Windows hides this backdrop behind the web contents, but macOS exposes it
 * during rubber-band overscroll and window resizes: a hardcoded white
 * backdrop made dark mode read as "not implemented" on Mac. Keep it in step
 * with the CSS theme at creation and on every theme change.
 */
export function themeBackgroundColor(theme: unknown): string {
  return theme === 'dark' ? '#1b1b1b' : '#faf9f8'
}

/**
 * manual = the renderer picked a concrete dark/light (pin it, so native UI
 * always matches). system = the renderer follows the OS via matchMedia —
 * nativeTheme.themeSource MUST stay 'system' here, otherwise prefers-color-
 * scheme freezes at the pinned value and the app stops tracking the OS.
 */
let themeSourceMode: 'manual' | 'system' = 'manual'

export function setThemeSourceMode(mode: 'manual' | 'system'): void {
  themeSourceMode = mode
}

export function applyWindowTheme(theme: unknown): void {
  const dark = theme === 'dark'
  const color = themeBackgroundColor(theme)
  // Native chrome (macOS title bar/traffic lights, context menus, scrollbars,
  // native dialogs) follows themeSource, not the CSS class. Without this the
  // app flipped dark while its native menus stayed light.
  nativeTheme.themeSource = themeSourceMode === 'system' ? 'system' : (dark ? 'dark' : 'light')
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.setBackgroundColor(color) } catch { /* window closing */ }
    }
  }
}
