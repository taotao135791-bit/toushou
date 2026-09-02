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

import { launchComposerPrompt, launchSkillSession, launchTool } from './launchTool'

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

describe('launchSkillSession', () => {
  it('creates the session with the skill id and arms a short reference line', async () => {
    createSessionForCurrentProject.mockResolvedValue('session-3')
    await expect(launchSkillSession('打法.md', '已加载团队 SKILL《打法》')).resolves.toBe('session-3')
    expect(createSessionForCurrentProject).toHaveBeenCalledWith({ skillId: '打法.md' })
    expect(setComposerPrefill).toHaveBeenCalledWith('已加载团队 SKILL《打法》')
    expect(setComposerAutosend).toHaveBeenCalledWith(true)
  })

  it('does not arm the composer when session creation is cancelled', async () => {
    createSessionForCurrentProject.mockResolvedValue(null)
    await expect(launchSkillSession('打法.md', 'ref')).resolves.toBeNull()
    expect(setComposerPrefill).not.toHaveBeenCalled()
    expect(setComposerAutosend).not.toHaveBeenCalled()
  })
})
