import { describe, expect, it } from 'vitest'
import { resolveRuntimeSettingDraft } from './runtimeModelDraft'

describe('resolveRuntimeSettingDraft', () => {
  it('uses the runtime value when the user has not started a local edit', () => {
    expect(resolveRuntimeSettingDraft(null, 'anthropic/claude-sonnet')).toBe('anthropic/claude-sonnet')
  })

  it('keeps an unsaved model choice when a late overview reports automatic', () => {
    // Reproduces Settings: a DeepSeek choice must not be replaced by a
    // stale `defaultModel: ""` response from an earlier overview request.
    expect(resolveRuntimeSettingDraft('deepseek/deepseek-v4', '')).toBe('deepseek/deepseek-v4')
  })

  it('preserves an explicit automatic draft instead of treating it as absent', () => {
    expect(resolveRuntimeSettingDraft('', 'anthropic/claude-sonnet')).toBe('')
  })
})
