import { useAppStore } from '../store'

/**
 * Create a chat session for the current workspace. With no project
 * selected the session silently anchors to the app-managed default
 * workspace (Documents/投手工作区): the home screen offers explicit project
 * choices, but pressing Enter must never dead-end on a folder picker.
 * Returns the new session id, or null when no workspace could be resolved.
 *
 * Next-session overrides (composer pickers used without an active session)
 * are snapshotted here and passed as spawn args. They are cleared only after
 * Main has actually created the session, so a failed create keeps the user's
 * picker choices for a retry.
 */
export async function createSessionForCurrentProject(
  extra?: { skillId?: string }
): Promise<string | null> {
  const {
    currentWorkspace,
    selectDefaultWorkspace,
    addSession,
    getSessionOverrides,
    clearSessionOverrides
  } = useAppStore.getState()
  let grant = currentWorkspace
  if (!grant) {
    await selectDefaultWorkspace()
    grant = useAppStore.getState().currentWorkspace
    if (!grant) return null
  }
  const overrides = getSessionOverrides()
  const session = await window.electronAPI.createSession(grant.id, { ...overrides, ...extra })
  // Clear only the values this successful request used. If the user changed a
  // picker while Main was creating the session, that newer choice is reserved
  // for the next session instead of being erased by this completion.
  clearSessionOverrides(overrides)
  addSession(session)
  return session.id
}
