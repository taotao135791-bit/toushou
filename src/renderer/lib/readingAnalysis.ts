import { useAppStore } from '../store'
import { createSessionForCurrentProject } from './session'

/** A deliberate analysis click starts its own chat without changing an unsent draft. */
export async function startReadingAnalysis(prompt: string): Promise<string | null> {
  if (!prompt.trim()) return null
  const sessionId = await createSessionForCurrentProject({ permissionMode: 'readonly' })
  if (!sessionId) return null
  const store = useAppStore.getState()
  store.enqueueQueuedMessage(sessionId, { id: crypto.randomUUID(), text: prompt })
  store.setCurrentSessionId(sessionId)
  return store.drainQueuedMessage(sessionId) ? sessionId : null
}
