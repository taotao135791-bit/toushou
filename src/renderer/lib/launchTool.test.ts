import { beforeEach, describe, expect, it, vi } from 'vitest'

const createSessionForCurrentProject = vi.fn()
const setComposerPrefill = vi.fn()
const setComposerAutosend = vi.fn()

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({ setComposerPrefill, setComposerAutosend })
  }
}))

vi.mock('./session', () => ({
  createSessionForCurrentProject: (...args: unknown[]) => createSessionForCurrentProject(...args)
}))

import { launchComposerPrompt, launchTool } from './launchTool'

beforeEach(() => {
  createSessionForCurrentProject.mockReset()
  setComposerPrefill.mockReset()
  setComposerAutosend.mockReset()
})

describe('launchComposerPrompt', () => {
  it('creates a session and arms autosend with the full prompt', async () => {
    createSessionForCurrentProject.mockResolvedValue('session-1')
    const prompt = '请严格按下面这份团队打法（SKILL）执行\n\n# 对话联动测试\n\n只回复 SKILL_CHAT_OK'
    await expect(launchComposerPrompt(prompt)).resolves.toBe('session-1')
    expect(setComposerPrefill).toHaveBeenCalledWith(prompt)
    expect(setComposerAutosend).toHaveBeenCalledWith(true)
  })

  it('does not arm the composer when session creation is cancelled', async () => {
    createSessionForCurrentProject.mockResolvedValue(null)
    await expect(launchComposerPrompt('x')).resolves.toBeNull()
    expect(setComposerPrefill).not.toHaveBeenCalled()
    expect(setComposerAutosend).not.toHaveBeenCalled()
  })

  it('keeps launchTool as a slash-command wrapper', async () => {
    createSessionForCurrentProject.mockResolvedValue('session-2')
    await expect(launchTool('/ads')).resolves.toBe('session-2')
    expect(setComposerPrefill).toHaveBeenCalledWith('/ads')
    expect(setComposerAutosend).toHaveBeenCalledWith(true)
  })
})
