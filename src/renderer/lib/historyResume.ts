import type { HistorySessionDescriptor, RecentWorkspaceDescriptor, WorkspaceGrant } from '@shared/types'
import type { SessionRecord } from './sessionRegistry'

export interface HistoryResumeState {
  currentWorkspace: WorkspaceGrant | null
  historyLoading: boolean
  recentWorkspaces: RecentWorkspaceDescriptor[]
  sessionRecords: SessionRecord[]
}
export type GlobalHistoryOpenResult = 'opened' | 'loading' | 'project-not-added' | 'history-unavailable' | 'resume-failed'

/** Call with the latest store state immediately before invoking Main. */
export function historyResumeGrant(state: HistoryResumeState, info: HistorySessionDescriptor, expectedWorkspace?: string): { ok: true; grant: WorkspaceGrant } | { ok: false; error: 'loading' | 'project-not-added' | 'history-unavailable' } {
  if (state.historyLoading) return { ok: false, error: 'loading' }
  const grant = state.currentWorkspace
  if (!grant || (expectedWorkspace && grant.realPath !== expectedWorkspace)) return { ok: false, error: 'project-not-added' }
  if (!state.sessionRecords.some(record => !record.isLive && record.workspaceRealPath === grant.realPath && record.history?.id === info.id)) return { ok: false, error: 'history-unavailable' }
  return { ok: true, grant }
}

/** Resolve a durable row only through a Main-issued, revalidated workspace grant. */
export async function openGlobalHistory(
  row: { uuid: string; cwd: string },
  deps: {
    getState: () => HistoryResumeState
    activateWorkspace: (id: string) => Promise<void>
    loadHistory: (grantId: string) => Promise<void>
    resume: (info: HistorySessionDescriptor, expectedWorkspace: string) => Promise<boolean>
  }
): Promise<GlobalHistoryOpenResult> {
  try {
    const initial = deps.getState()
    if (!initial.currentWorkspace || initial.currentWorkspace.realPath !== row.cwd) {
      // Main canonicalizes recent descriptors before returning them. Basename
      // matching can silently choose the wrong one when projects share a name.
      const target = initial.recentWorkspaces.find(entry => entry.displayPath === row.cwd)
      if (!target) return 'project-not-added'
      await deps.activateWorkspace(target.id)
    }
    const grant = deps.getState().currentWorkspace
    if (!grant || grant.realPath !== row.cwd) return 'project-not-added'
    // Activation can already have started the target scan in the Sidebar.
    // Await/coalesce that trusted scope instead of turning the first click
    // into a workspace-only switch. A scan for the previous project must
    // not prevent selecting this project either.
    await deps.loadHistory(grant.id)
    const fresh = deps.getState()
    if (fresh.currentWorkspace?.id !== grant.id || fresh.currentWorkspace.realPath !== row.cwd || fresh.historyLoading) return 'history-unavailable'
    const match = fresh.sessionRecords.find(record => !record.isLive && record.workspaceRealPath === row.cwd && record.history?.uuid === row.uuid)
    if (!match?.history) return 'history-unavailable'
    return await deps.resume(match.history, row.cwd) ? 'opened' : 'resume-failed'
  } catch { return 'history-unavailable' }
}

/** Persist a completed resume, but never steal focus after a workspace switch. */
export function finishHistoryResume(
  grant: WorkspaceGrant,
  actions: {
    save: () => void
    currentWorkspace: () => WorkspaceGrant | null
    select: () => void
  }
): boolean {
  // Saving must register the live session without selecting it. This preserves
  // the result even if the user left the project while Main was restoring it.
  actions.save()
  const current = actions.currentWorkspace()
  if (!current || current.id !== grant.id || current.realPath !== grant.realPath) return false
  actions.select()
  return true
}
