import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@shared/types'
import { useAppStore } from './index'

const sessionId = 'ui-request-test'

function request(id: string): Extract<SessionEvent, { type: 'ui_request' }> {
  return {
    type: 'ui_request',
    sessionId,
    id,
    method: 'confirm',
    title: 'Continue?'
  }
}

beforeEach(() => {
  useAppStore.setState({ uiRequests: {} })
})

describe('extension UI request store', () => {
  it('does not enqueue the same upstream request id twice', () => {
    useAppStore.getState().applySessionEvent(request('same'))
    useAppStore.getState().applySessionEvent(request('same'))

    expect(useAppStore.getState().uiRequests[sessionId]).toHaveLength(1)
  })

  it('resolves exactly one request even if malformed state contains duplicate ids', () => {
    useAppStore.setState({ uiRequests: { [sessionId]: [request('same'), request('same')] } })

    useAppStore.getState().resolveUiRequest(sessionId, 'same')

    expect(useAppStore.getState().uiRequests[sessionId]).toHaveLength(1)
  })

  it('removes only the matching request when an extension sends cancel', () => {
    useAppStore.setState({ uiRequests: { [sessionId]: [request('first'), request('second')] } })

    useAppStore.getState().applySessionEvent({ type: 'ui_cancel', sessionId, id: 'first' })

    expect(useAppStore.getState().uiRequests[sessionId].map((item) => item.id)).toEqual(['second'])
  })
})
