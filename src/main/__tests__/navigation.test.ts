import { describe, expect, it, vi } from 'vitest'
import {
  GuardedWebContents,
  installNavigationGuards,
  isAllowedAppNavigation,
  safeExternalUrl,
  safeLoginExternalUrl
} from '../navigation'

const policy = { rendererEntryPath: '/app/renderer/index.html' }

class FakeWebContents implements GuardedWebContents {
  readonly listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>()
  openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined

  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (event: { preventDefault(): void }, url: string) => void
  ) {
    this.listeners.set(event, listener)
  }

  setWindowOpenHandler(listener: (details: { url: string }) => { action: 'deny' }) {
    this.openHandler = listener
  }

  navigate(event: 'will-navigate' | 'will-redirect', url: string) {
    const preventDefault = vi.fn()
    this.listeners.get(event)?.({ preventDefault }, url)
    return preventDefault
  }
}

describe('safeExternalUrl', () => {
  it('accepts ordinary HTTP(S) web URLs and normalizes them', () => {
    expect(safeExternalUrl('https://example.com/docs?q=one#section')).toBe(
      'https://example.com/docs?q=one#section'
    )
    expect(safeExternalUrl('http://localhost:43123/callback')).toBe(
      'http://localhost:43123/callback'
    )
  })

  it('rejects non-web, malformed, padded, and credential-bearing URLs', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      'mailto:hello@example.com',
      'https://user:secret@example.com',
      ' https://example.com',
      'https://example.com\nnext',
      'not a url'
    ]) {
      expect(safeExternalUrl(value)).toBeNull()
    }
  })
})

describe('safeLoginExternalUrl', () => {
  it('permits HTTPS and loopback HTTP only', () => {
    expect(safeLoginExternalUrl('https://provider.example/login')).toBe('https://provider.example/login')
    expect(safeLoginExternalUrl('http://localhost:43123/callback')).toBe(
      'http://localhost:43123/callback'
    )
    expect(safeLoginExternalUrl('http://127.0.0.1:43123/callback')).toBe(
      'http://127.0.0.1:43123/callback'
    )
    expect(safeLoginExternalUrl('http://provider.example/login')).toBeNull()
    expect(safeLoginExternalUrl('https://user:secret@provider.example/login')).toBeNull()
  })
})

describe('isAllowedAppNavigation', () => {
  it('allows only the packaged renderer document', () => {
    expect(isAllowedAppNavigation('file:///app/renderer/index.html#/settings', policy)).toBe(true)
    expect(isAllowedAppNavigation('file:///app/renderer/other.html', policy)).toBe(false)
    expect(isAllowedAppNavigation('https://example.com', policy)).toBe(false)
  })

  it('allows only the Vite origin during development', () => {
    const devPolicy = { ...policy, devServerUrl: 'http://localhost:5173' }
    expect(isAllowedAppNavigation('http://localhost:5173/#/settings', devPolicy)).toBe(true)
    expect(isAllowedAppNavigation('http://localhost:5174/', devPolicy)).toBe(false)
    expect(isAllowedAppNavigation('file:///app/renderer/index.html', devPolicy)).toBe(false)
  })
})

describe('installNavigationGuards', () => {
  it('blocks remote navigations and redirects, and routes only safe popups externally', async () => {
    const webContents = new FakeWebContents()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    installNavigationGuards(webContents, policy, openExternal)

    expect(webContents.navigate('will-navigate', 'https://example.com')).toHaveBeenCalledOnce()
    expect(webContents.navigate('will-redirect', 'https://example.com')).toHaveBeenCalledOnce()
    expect(webContents.navigate('will-navigate', 'file:///app/renderer/index.html#/boards')).not.toHaveBeenCalled()

    expect(webContents.openHandler?.({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' })
    expect(webContents.openHandler?.({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
