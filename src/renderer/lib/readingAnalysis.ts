import { useAppStore } from '../store'
import { createSessionForCurrentProject } from './session'
import { beginNavigationIntent, isCurrentNavigationIntent } from './navigationIntent'

/** A deliberate analysis click starts its own chat without changing an unsent draft. */
export async function startReadingAnalysis(prompt: string, intent = beginNavigationIntent()): Promise<string | null> {
  if (!prompt.trim() || !isCurrentNavigationIntent(intent)) return null
  const sessionId = await createSessionForCurrentProject({ permissionMode: 'readonly' }, intent)
  if (!sessionId) return null
  const store = useAppStore.getState()
  store.enqueueQueuedMessage(sessionId, { id: crypto.randomUUID(), text: prompt })
  if (isCurrentNavigationIntent(intent)) store.setCurrentSessionId(sessionId, intent)
  return store.drainQueuedMessage(sessionId) ? sessionId : null
}

/** Late board-reading launches still send to their own session, not the foreground composer. */
export function deliverBoardReading(sessionId: string, prompt: string, intent: number): 'foreground' | 'background' | 'failed' {
  const store = useAppStore.getState()
  store.setBoardReadingLaunch({ sessionId, prompt, startedAt: Date.now() })
  if (isCurrentNavigationIntent(intent)) {
    store.setCurrentSessionId(sessionId, intent)
    store.setComposerPrefill(prompt)
    store.setComposerAutosend(true)
    return 'foreground'
  }
  store.enqueueQueuedMessage(sessionId, { id: crypto.randomUUID(), text: prompt })
  return store.drainQueuedMessage(sessionId) ? 'background' : 'failed'
}
