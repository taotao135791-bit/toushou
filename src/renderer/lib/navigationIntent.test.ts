import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginNavigationIntent, currentNavigationIntent, isCurrentNavigationIntent } from './navigationIntent'
import { useAppStore } from '../store'

afterEach(() => vi.unstubAllGlobals())
describe('shared user navigation intent', () => {
  it('records New Chat even when the selected session was already null', () => {
    useAppStore.setState({ currentSessionId: null })
    const older = beginNavigationIntent()
    useAppStore.getState().setCurrentSessionId(null)
    expect(currentNavigationIntent()).toBeGreaterThan(older)
    expect(isCurrentNavigationIntent(older)).toBe(false)
    useAppStore.getState().setCurrentSessionId('old-restored-session', older)
    expect(useAppStore.getState().currentSessionId).toBeNull()
  })

  it('reuses the captured intent for internal selection and grant adoption', () => {
    vi.stubGlobal('window', { electronAPI: { getSubagents: vi.fn().mockResolvedValue([]) } })
    const intent = beginNavigationIntent()
    useAppStore.getState().setCurrentWorkspace({ id: 'grant', realPath: '/synthetic/a', displayPath: '/synthetic/a', source: 'dialog', createdAt: 1 })
    useAppStore.getState().setCurrentSessionId('restored', intent)
    expect(currentNavigationIntent()).toBe(intent)
    expect(useAppStore.getState().currentSessionId).toBe('restored')
  })
})
