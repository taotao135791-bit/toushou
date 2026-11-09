import type { BoardRefreshStatus } from '@shared/boardRefresh'

export type ManagedReadingViewStatus = BoardRefreshStatus | 'pending' | 'stale'

/**
 * Status a reading module shows on the board.
 *
 * A master date change invalidates the current refresh plan and drops its
 * widget views without starting a query. That intermediate state is `stale`
 * (waiting for a manual refresh), never `pending`: modules read `pending` as an
 * in-flight request, which spins their own refresh button and disables it while
 * nothing is running. `pending` therefore requires an actual plan in flight.
 */
export function managedReadingStatus(input: {
  /** Status reported by the last completed refresh plan, when still valid. */
  viewStatus?: BoardRefreshStatus
  /** A refresh plan is actively running for this board. */
  planPending: boolean
  /** The last completed plan reported a failure for this source. */
  failed: boolean
}): ManagedReadingViewStatus {
  if (input.viewStatus) return input.viewStatus
  if (input.planPending) return 'pending'
  return input.failed ? 'failed' : 'stale'
}
