import { useAppStore } from '../store'
import { createSessionForCurrentProject } from './session'

/**
 * One-click tool launch: create a fresh session for the current workspace,
 * then arm the composer with the tool's slash command and auto-send it.
 * Returns the new session id, or null when the folder picker was cancelled.
 * The caller navigates to the chat on success — prefill survives the route
 * change because it lives in the store, not the component.
 */
export async function launchTool(command: string): Promise<string | null> {
  const id = await createSessionForCurrentProject()
  if (!id) return null
  const store = useAppStore.getState()
  store.setComposerPrefill(command)
  store.setComposerAutosend(true)
  return id
}
