/**
 * Shared model-selector parsing used by BOTH the main and renderer processes.
 * The main-process `src/main/omp/settings/modelSelector.ts` owns the safety
 * validation (argv/IPC) and provider/model splitting; this shared module owns
 * the *thinking suffix* convention only:
 *
 *   `provider/model:high`  →  { modelSelector: 'provider/model', thinkingOverride: 'high' }
 *
 * Oh My Pi encodes a per-model thinking override as a `:level` suffix on the
 * selector (verified as legal upstream — `isValidModelSelector` already accepts
 * the colon). The GUI must never silently drop that suffix when a user changes
 * only the model half of a selector (e.g. `A:high` → `B:high`).
 *
 * Only a suffix that matches a KNOWN session thinking level and whose remainder
 * still contains a provider/model split is treated as an override, so a model
 * id that legitimately ends in `:something` (unknown token) round-trips as the
 * bare selector rather than being mis-parsed.
 */

/** The session thinking levels a `:level` suffix may denote. */
export const THINKING_SUFFIX_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export interface ModelSelectorParts {
  /** `provider/model` with the thinking suffix removed. */
  modelSelector: string
  /** The trailing thinking level, when one was present. */
  thinkingOverride?: string
}

/**
 * Split a selector into its model and thinking-override parts. Null only for a
 * non-string / empty input; a selector with no thinking suffix returns
 * `{ modelSelector: selector }`.
 */
export function parseModelSelector(selector: string): ModelSelectorParts | null {
  if (typeof selector !== 'string' || selector.length === 0) return null
  const match = selector.match(/^(.+):([a-z0-9]+)$/)
  if (
    match &&
    THINKING_SUFFIX_LEVELS.includes(match[2]) &&
    match[1].includes('/')
  ) {
    return { modelSelector: match[1], thinkingOverride: match[2] }
  }
  return { modelSelector: selector }
}

/** Recombine parts back into a full selector. */
export function formatModelSelector(parts: ModelSelectorParts): string {
  return parts.thinkingOverride
    ? `${parts.modelSelector}:${parts.thinkingOverride}`
    : parts.modelSelector
}

/**
 * Replace only the model half of a selector, preserving any thinking override.
 * This is the exact "A:high → B:high" rule: switching the default model keeps
 * the role-level thinking override the user already chose.
 *
 * When `next` already carries its own `:level` override it wins verbatim (the
 * caller's explicit choice), so an override is never double-applied.
 */
export function switchModelSelector(previous: string, next: string): string {
  const nextParts = parseModelSelector(next)
  if (nextParts?.thinkingOverride) return next
  const prevParts = parseModelSelector(previous)
  if (prevParts?.thinkingOverride) {
    return formatModelSelector({
      modelSelector: next,
      thinkingOverride: prevParts.thinkingOverride
    })
  }
  return next
}
