import { useAppStore } from '../store'
import { createSessionForCurrentProject } from './session'

/**
 * One-click tool launch: create a fresh session for the current workspace,
 * then arm the composer with the tool's slash command and auto-send it.
 * Returns the new session id, or null when the folder picker was cancelled.
 * The caller navigates to the chat on success — prefill survives the route
 * change because it lives in the store, not the component.
 */
export async function launchComposerPrompt(text: string): Promise<string | null> {
  const id = await createSessionForCurrentProject()
  if (!id) return null
  const store = useAppStore.getState()
  store.setComposerPrefill(text)
  store.setComposerAutosend(true)
  return id
}

/** Slash-command launch used by the Tools panel and plugins page. */
export async function launchTool(command: string): Promise<string | null> {
  return launchComposerPrompt(command)
}

/**
 * SKILL launch: create a session whose system prompt carries the skill's
 * SOP (Main resolves the id and injects the content), then auto-send a
 * short reference line. The playbook rides in context, not the composer.
 */
export async function launchSkillSession(
  skillId: string,
  referenceText: string
): Promise<string | null> {
  const id = await createSessionForCurrentProject({ skillId })
  if (!id) return null
  const store = useAppStore.getState()
  store.setComposerPrefill(referenceText)
  store.setComposerAutosend(true)
  return id
}
