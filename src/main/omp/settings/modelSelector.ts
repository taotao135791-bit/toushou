/**
 * The single model-selector validation helper for the whole GUI. Every
 * Current OMP model-selector IPC path (set default model, set session model,
 * next-session override) uses `isValidModelSelector` / `splitModelSelector`
 * from here — no IPC regex, no renderer regex, no duplicate rule set.
 *
 * The GUI deliberately does NOT replicate the runtime's naming rules:
 * existence is the runtime's call. We only guarantee argv/IPC safety:
 * non-empty, bounded, no NUL, no control characters. Slashes, dots, dashes,
 * underscores, and attribute-like punctuation (spaces are the one thing we
 * still refuse, since a selector is a single argv token) are all legal.
 */

/** Soft prefix that can denote known selector attributes (`name:value`). */
const MAX_SELECTOR_LENGTH = 300

/**
 * Model selector validation. Real selectors look like
 * `openrouter/deepseek/deepseek-v4-flash-0731` — provider is the first
 * segment, the rest (slashes included) is the model id.
 */
export function isValidModelSelector(selector: string): boolean {
  if (typeof selector !== 'string') return false
  if (selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH) return false
  if (selector.startsWith('-')) return false
  if (selector.includes(' ')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(selector)) return false
  return true
}

/**
 * Split a selector into provider + modelId: provider is the first segment,
 * modelId is everything after it (which may itself contain slashes).
 * Null for selectors without both a provider and a model id.
 */
export function splitModelSelector(selector: string): { provider: string; modelId: string } | null {
  if (!isValidModelSelector(selector)) return null
  const slash = selector.indexOf('/')
  if (slash === -1) return null
  const provider = selector.slice(0, slash)
  const modelId = selector.slice(slash + 1)
  if (!provider || !modelId) return null
  return { provider, modelId }
}

/** Provider-id shape shared with the login/logout IPC validators. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/