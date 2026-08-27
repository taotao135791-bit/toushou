import { SessionState } from '@shared/types'

/**
 * Per-turn runtime snapshot: the session's ACTUAL model/thinking at the
 * moment a prompt is dispatched. Historical turns must stay self-describing
 * and never be re-rendered from the session's later current state.
 */

export interface RuntimeSnapshot {
  /** `provider/id` selector (id may itself contain slashes). */
  modelSelector?: string
  /** Session RPC thinking level reported by get_state ('' / undefined = auto). */
  thinkingLevel?: string
}

function modelSelectorOf(state: SessionState | null): string | undefined {
  const m = state?.model
  if (!m || typeof m !== 'object') return undefined
  const o = m as { provider?: unknown; id?: unknown }
  if (typeof o.provider !== 'string' || typeof o.id !== 'string') return undefined
  return `${o.provider}/${o.id}`
}

/**
 * Snapshot the live session's runtime state at dispatch time. Missing /
 * unavailable state yields an empty snapshot (the caller renders no tag),
 * never a fallback to some other store.
 */
export async function captureSessionSnapshot(sessionId: string | null): Promise<RuntimeSnapshot> {
  if (!sessionId) return {}
  try {
    const state = await window.electronAPI.getSessionState(sessionId)
    return {
      modelSelector: modelSelectorOf(state),
      thinkingLevel: state?.thinkingLevel || undefined
    }
  } catch {
    return {}
  }
}