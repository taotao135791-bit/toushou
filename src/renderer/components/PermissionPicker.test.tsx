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
  it('leaves a normal session using the global mode and the remote tooltip distinct', () => {
    Object.assign(fixture.state, { currentSessionId: 'normal', sessions: [{ id: 'normal' }] })
    const normal = renderToStaticMarkup(<PermissionPicker />)
    expect(normal).not.toContain(' disabled=""')
    expect(normal).toContain('>Ask</span>')
    Object.assign(fixture.state, { currentSessionId: 'remote', sessions: [{ id: 'remote', remoteReadonly: true }] })
    const remote = renderToStaticMarkup(<PermissionPicker />)
    expect(remote).toContain('Remote (Feishu) sessions are fixed to read-only.')
    expect(remote).toContain('Read-only')
    expect(remote).toContain(' disabled=""')
  })
})
