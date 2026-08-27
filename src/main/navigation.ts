import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** URLs passed to the OS are deliberately limited to ordinary web pages. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])
const MAX_EXTERNAL_URL_LENGTH = 8_192

export interface NavigationPolicy {
  /** Vite's origin while developing (for example http://localhost:5173). */
  devServerUrl?: string
  /** The one packaged renderer document the primary window is allowed to load. */
  rendererEntryPath: string
}

interface PreventableEvent {
  preventDefault(): void
}

/** The small WebContents surface used by the navigation guard (test-friendly). */
export interface GuardedWebContents {
  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (event: PreventableEvent, url: string) => void
  ): unknown
  setWindowOpenHandler(listener: (details: { url: string }) => { action: 'deny' }): void
}

/**
 * Normalize a URL before it can leave the app. This is intentionally not a
 * general shell opener: filesystem, custom-protocol, javascript and data URLs
 * must never cross the renderer/Main boundary as external navigation.
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) {
    return null
  }
  // Silently trimming would make the value Main opens differ from the one the
  // user saw in the renderer. Reject control characters and padded URLs.
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null

  try {
    const url = new URL(value)
    if (!EXTERNAL_PROTOCOLS.has(url.protocol) || !url.hostname) return null
    // Credentials in a Markdown link are almost always accidental and can
    // make the browser disclose secrets to an unexpected host.
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Login flows may use HTTPS pages and a local HTTP callback only. This is a
 * stricter policy than ordinary external links while retaining the same URL
 * normalization and credential rejection rules.
 */
export function safeLoginExternalUrl(value: unknown): string | null {
  const normalized = safeExternalUrl(value)
  if (!normalized) return null
  const url = new URL(normalized)
  if (url.protocol === 'https:') return normalized
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    ? normalized
    : null
}

/**
 * The main BrowserWindow is an application surface, not a browser tab. Permit
 * only Vite's own origin in development or the packaged renderer index file.
 */
export function isAllowedAppNavigation(urlValue: string, policy: NavigationPolicy): boolean {
  let target: URL
  try {
    target = new URL(urlValue)
  } catch {
    return false
  }

  if (policy.devServerUrl) {
    try {
      return target.origin === new URL(policy.devServerUrl).origin
    } catch {
      return false
    }
  }

  if (target.protocol !== 'file:') return false
  try {
    return path.resolve(fileURLToPath(target)) === path.resolve(policy.rendererEntryPath)
  } catch {
    return false
  }
}

/**
 * Block every navigation away from the trusted renderer. Popups are never
 * created; safe web URLs are delegated to the OS browser instead.
 */
export function installNavigationGuards(
  webContents: GuardedWebContents,
  policy: NavigationPolicy,
  openExternal: (url: string) => Promise<unknown> | unknown
): void {
  const blockUnexpectedNavigation = (event: PreventableEvent, url: string) => {
    if (!isAllowedAppNavigation(url, policy)) event.preventDefault()
  }

  webContents.on('will-navigate', blockUnexpectedNavigation)
  webContents.on('will-redirect', blockUnexpectedNavigation)
  webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalUrl(url)
    if (safeUrl) {
      // setWindowOpenHandler is synchronous. Never allow a popup while the
      // system-browser request is in flight, and never leak an unhandled
      // rejection from shell.openExternal.
      void Promise.resolve(openExternal(safeUrl)).catch(() => undefined)
    }
    return { action: 'deny' }
  })
}
