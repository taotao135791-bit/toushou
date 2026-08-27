import { app, nativeTheme } from 'electron'
import Store from 'electron-store'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AppSettings, DEFAULT_SETTINGS, ToolAccess } from '../shared/types'

// electron-store persists defaults on construction, so capture the raw file
// first to tell a user's own choice apart from a fresh default.
const settingsFile = path.join(app.getPath('userData'), 'omp-gui-settings.json')
let persisted: Record<string, unknown> = {}
try {
  persisted = JSON.parse(readFileSync(settingsFile, 'utf-8'))
} catch {
  persisted = {}
}

const store = new Store<AppSettings>({
  name: 'omp-gui-settings',
  defaults: DEFAULT_SETTINGS
})

/**
 * First-run defaults that need app-ready APIs — called from index.ts inside
 * whenReady, before the window is created. NOTE: must check the raw
 * persisted file — store.has() is always true for defaulted keys; and
 * getSystemLocale() (not getLocale(), which reads the app bundle) — bundles
 * without localization resources always report 'en'.
 */
export function applyFirstRunDefaults(): void {
  if (!('language' in persisted)) {
    store.set('language', app.getSystemLocale().startsWith('zh') ? 'zh' : 'en')
  }
  if (!('theme' in persisted)) {
    store.set('theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  }
}

// One-time migration: a legacy toolAccess choice becomes the permissionMode,
// so existing users keep their tier instead of dropping to the 'ask' default.
const legacyToolAccess = persisted.toolAccess
if (
  !('permissionMode' in persisted) &&
  (legacyToolAccess === 'full' || legacyToolAccess === 'no-bash' || legacyToolAccess === 'readonly')
) {
  store.set('permissionMode', legacyToolAccess as ToolAccess)
}

export function getStore<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return store.get(key)
}

export function setStore<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  store.set(key, value)
}

/** Persist a canonical workspace path. Only Main calls this helper. */
export function rememberRecentProject(realPath: string): void {
  const recent = getStore('recentProjects')
  if (recent.includes(realPath)) return
  setStore('recentProjects', [realPath, ...recent].slice(0, 10))
}
