/** User navigation is an intent, including selecting the same value again. */
let revision = 0

export function beginNavigationIntent(): number { return ++revision }
export function currentNavigationIntent(): number { return revision }
export function isCurrentNavigationIntent(intent: number): boolean { return intent === revision }

export const historyPreviewRouteState = { historyPreviewNavigation: true } as const

/** Showing a pending history preview is part of the original open intent. */
export function recordRouteNavigation(type: string, state: unknown): void {
  if (type !== 'POP' && state && typeof state === 'object' &&
      'historyPreviewNavigation' in state && state.historyPreviewNavigation === true) return
  beginNavigationIntent()
}
