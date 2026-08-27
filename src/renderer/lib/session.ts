import { useAppStore } from '../store'

/**
 * Create a chat session for the current workspace, prompting for a folder
 * when none is selected. Returns the new session id, or null when the
 * user cancelled the folder picker.
 *
 * Next-session overrides (composer pickers used without an active session)
 * are snapshotted here and passed as spawn args. They are cleared only after
 * Main has actually created the session, so a failed create keeps the user's
 * picker choices for a retry.
 */
export async function createSessionForCurrentProject(): Promise<string | null> {
  const {
    currentWorkspace,
    selectWorkspace,
    addSession,
    getSessionOverrides,
    clearSessionOverrides
  } = useAppStore.getState()
  let grant = currentWorkspace
  if (!grant) {
    await selectWorkspace()
    grant = useAppStore.getState().currentWorkspace
    if (!grant) return null
  }
  const overrides = getSessionOverrides()
  const session = await window.electronAPI.createSession(grant.id, overrides)
  // Clear only the values this successful request used. If the user changed a
  // picker while Main was creating the session, that newer choice is reserved
  // for the next session instead of being erased by this completion.
  clearSessionOverrides(overrides)
  addSession(session)
  return session.id
}
