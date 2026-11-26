import { useAppStore } from '../store'
import { beginNavigationIntent, isCurrentNavigationIntent } from './navigationIntent'

/**
 * Create a chat session for the current workspace. With no project
 * selected the session silently anchors to the app-managed default
 * workspace (Documents/投手工作区): the home screen offers explicit project
 * choices. If the default directory needs confirmation, the home screen offers
 * recovery and this function leaves the draft and picker choices intact.
 * Returns the new session id, or null when no workspace could be resolved.
 *
 * Snapshot the composer's most recent choices for each new conversation.
 */
export async function createSessionForCurrentProject(
  extra?: { skillId?: string; permissionMode?: 'readonly' },
  intent = beginNavigationIntent()
): Promise<string | null> {
  if (!isCurrentNavigationIntent(intent)) return null
  const {
    currentWorkspace,
    selectDefaultWorkspace,
    addSession,
    getSessionOverrides
  } = useAppStore.getState()
  let grant = currentWorkspace
  if (!grant) {
    await selectDefaultWorkspace(intent)
    grant = useAppStore.getState().currentWorkspace
    if (!grant || !isCurrentNavigationIntent(intent)) return null
  }
  const overrides = getSessionOverrides()
  const session = await window.electronAPI.createSession(grant.id, { ...overrides, ...extra })
  // Preserve the created session for the submitted prompt, but a newer user
  // choice owns the foreground. Internal adoption reuses the original intent.
  addSession(session, false)
  if (isCurrentNavigationIntent(intent) && useAppStore.getState().currentWorkspace?.id === grant.id) {
    useAppStore.getState().setCurrentSessionId(session.id, intent)
  }
  return session.id
}
