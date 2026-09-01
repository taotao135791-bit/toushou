import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from './index'

const sessionId = 'session-event-test'

afterEach(() => {
  useAppStore.setState({ messages: {}, executions: {} })
})

describe('session message events', () => {
  it('keeps system notices as quiet system messages', () => {
    useAppStore.getState().applySessionEvent({
      type: 'message',
      sessionId,
      role: 'system',
      variant: 'info',
      content: 'Extension UI was ignored.'
    })

    expect(useAppStore.getState().messages[sessionId]).toEqual([
      expect.objectContaining({
        role: 'system',
        variant: 'info',
        content: 'Extension UI was ignored.'
      })
    ])
  })
})
