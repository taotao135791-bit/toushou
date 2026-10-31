import { describe, expect, it } from 'vitest'
import { SessionBridgePermissionRegistry } from './bridgePermissions'

describe('Main session bridge permission registry', () => {
  it('narrows live sessions when the global setting changes but cannot widen them', () => {
    const p = new SessionBridgePermissionRegistry()
    p.register('ask', 'ask', false)
    expect(p.get('ask', 'readonly')?.mode).toBe('readonly')
    expect(p.get('ask', 'full')?.mode).toBe('ask')
    p.update('ask', 'full')
    expect(p.get('ask', 'full')?.mode).toBe('full')
    p.update('ask', 'ask')
    expect(p.get('ask', 'full')?.mode).toBe('ask')
  })
  it('keeps remote and scheduled readonly sessions restricted across attempts to elevate', () => {
    const p = new SessionBridgePermissionRegistry()
    p.register('remote', 'readonly', true)
    p.register('task', 'readonly', false)
    p.update('remote', 'full'); p.update('task', 'full')
    expect(p.get('remote', 'full')).toEqual({ mode: 'readonly', remoteReadonly: true })
    expect(p.get('task', 'full')).toEqual({ mode: 'readonly', remoteReadonly: false })
    p.remove('remote')
    expect(p.get('remote', 'full')).toBeNull()
  })
  it('never lets an invalid persisted mode turn into full access', () => {
    const p = new SessionBridgePermissionRegistry()
    p.register('a', 'full', false)
    expect(p.get('a', 'bad' as never)?.mode).toBe('readonly')
  })
})
