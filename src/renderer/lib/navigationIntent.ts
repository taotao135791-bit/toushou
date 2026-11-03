/** User navigation is an intent, including selecting the same value again. */
let revision = 0

export function beginNavigationIntent(): number { return ++revision }
export function currentNavigationIntent(): number { return revision }
export function isCurrentNavigationIntent(intent: number): boolean { return intent === revision }
