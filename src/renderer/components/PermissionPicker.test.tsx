import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const fixture = vi.hoisted(() => ({ state: { language: 'en', permissionMode: 'ask', currentSessionId: '', sessions: [] as Array<Record<string, unknown>>, runtimeOverview: null, setPermissionMode: vi.fn() } }))
vi.mock('../store', () => ({ useAppStore: (select: (state: typeof fixture.state) => unknown) => select(fixture.state) }))
vi.mock('./MenuPortal', () => ({ default: () => null }))
import PermissionPicker from './PermissionPicker'

describe('session permission display', () => {
  it('shows a fixed readonly session independently of the global default', () => {
    Object.assign(fixture.state, { currentSessionId: 'read', sessions: [{ id: 'read', readonly: true }] })
    const html = renderToStaticMarkup(<PermissionPicker />)
    expect(html).toContain('Read-only')
    expect(html).toContain('This session is fixed to read-only.')
    expect(html).toContain(' disabled=""')
    expect(fixture.state.permissionMode).toBe('ask')
    expect(fixture.state.setPermissionMode).not.toHaveBeenCalled()
  })
  it('shows Main mode for a live session and labels the future default separately', () => {
    Object.assign(fixture.state, { currentSessionId: 'normal', sessions: [{ id: 'normal', nativePermissionMode: 'full', nativePermissionMutable: false }] })
    const normal = renderToStaticMarkup(<PermissionPicker />)
    expect(normal).not.toContain(' disabled=""')
    expect(normal).toContain('>Full access</span>')
    expect(normal).toContain('Current chat · Full access')
    expect(normal).toContain('New chat default · Ask')
    Object.assign(fixture.state, { currentSessionId: '', sessions: [] })
    const home = renderToStaticMarkup(<PermissionPicker />)
    expect(home).toContain('>Ask</span>')
    expect(home).not.toContain('Current chat')
  })
  it('preserves the distinct remote tooltip', () => {
    Object.assign(fixture.state, { currentSessionId: 'remote', sessions: [{ id: 'remote', remoteReadonly: true }] })
    const remote = renderToStaticMarkup(<PermissionPicker />)
    expect(remote).toContain('Remote (Feishu) sessions are fixed to read-only.')
    expect(remote).toContain('Read-only')
    expect(remote).toContain(' disabled=""')
  })
})
