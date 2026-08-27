export type SessionStatusKind = 'error' | 'attention' | 'running' | 'unread' | 'idle'

export interface SessionStatusInput {
  busy: boolean
  waiting: boolean
  error: boolean
  unread: boolean
}

/**
 * Project the existing runtime/session fields into one user-facing priority.
 * This is intentionally a pure view helper; it owns no state.
 */
export function getSessionStatus({ busy, waiting, error, unread }: SessionStatusInput): SessionStatusKind {
  if (error) return 'error'
  if (waiting) return 'attention'
  if (busy) return 'running'
  if (unread) return 'unread'
  return 'idle'
}

