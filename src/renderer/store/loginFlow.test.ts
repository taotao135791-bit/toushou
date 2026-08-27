import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './index'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('native login store bridge', () => {
  it('forwards interactive login actions and preserves their IPC result', async () => {
    const authStartLogin = vi.fn().mockResolvedValue({ ok: true })
    const authAnswerLogin = vi.fn().mockResolvedValue({ ok: false, error: 'prompt expired' })
    const authCancelLogin = vi.fn().mockResolvedValue({ ok: true })
    const authOpenLoginUrl = vi.fn().mockResolvedValue({ ok: false, error: 'invalid url' })
    vi.stubGlobal('window', {
      electronAPI: { authStartLogin, authAnswerLogin, authCancelLogin, authOpenLoginUrl }
    })

    await expect(useAppStore.getState().startLogin('deepseek')).resolves.toEqual({ ok: true })
    await expect(useAppStore.getState().answerLogin({ value: 'one-time-code' })).resolves.toEqual({
      ok: false,
      error: 'prompt expired'
    })
    await expect(useAppStore.getState().cancelLogin()).resolves.toEqual({ ok: true })
    await expect(useAppStore.getState().openLoginUrl('https://example.com/login')).resolves.toEqual({
      ok: false,
      error: 'invalid url'
    })

    expect(authStartLogin).toHaveBeenCalledWith('deepseek')
    expect(authAnswerLogin).toHaveBeenCalledWith({ value: 'one-time-code' })
    expect(authCancelLogin).toHaveBeenCalledWith()
    expect(authOpenLoginUrl).toHaveBeenCalledWith('https://example.com/login')
  })
})
