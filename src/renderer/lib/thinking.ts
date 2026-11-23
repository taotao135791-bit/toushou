import {
  DefaultThinkingLevel,
  DEFAULT_THINKING_LEVELS,
  RuntimeModelInfo,
  SessionThinkingLevel,
  SESSION_THINKING_LEVELS
} from '@shared/types'

type ThinkingCapabilities = Pick<RuntimeModelInfo, 'thinking'> & Partial<Pick<RuntimeModelInfo, 'reasoning'>>

const EFFORT_LEVELS = SESSION_THINKING_LEVELS.filter((level) => level !== 'off')

function knownEfforts(capabilities?: ThinkingCapabilities) {
  return EFFORT_LEVELS.filter((level) => capabilities?.thinking.includes(level))
}

/**
 * Session thinking options (composer picker / set_thinking_level / --thinking).
 * Prefer the live model, then its catalog entry. A list without a recognized
 * effort gives no upper bound; the runtime resolves the requested level.
 */
export function sessionThinkingOptionsFor(
  profile: 'current' | 'legacy',
  catalogEntry?: ThinkingCapabilities,
  liveModel?: ThinkingCapabilities
): readonly SessionThinkingLevel[] {
  if (profile !== 'current') {
    return SESSION_THINKING_LEVELS.filter((l) => l !== 'max')
  }
  if (liveModel?.reasoning === false) return ['off']
  const liveEfforts = knownEfforts(liveModel)
  if (liveEfforts.length > 0) return ['off', ...liveEfforts]
  const catalogEfforts = knownEfforts(catalogEntry)
  if (catalogEfforts.length > 0) return ['off', ...catalogEfforts]
  return catalogEntry?.reasoning === false && liveModel?.reasoning !== true
    ? ['off']
    : SESSION_THINKING_LEVELS
}

/**
 * Default-thinking options for Settings (config `defaultThinkingLevel` enum).
 * This is a DIFFERENT domain from the session enum: `auto` is legal, `off`
 * is not — verified against current Oh My Pi 17.2.12.
 *
 * The default always offers `auto`, and uses the model's concrete efforts
 * when available. Unknown model capabilities fall back to the config enum.
 */
export function defaultThinkingOptionsFor(
  catalogEntry?: ThinkingCapabilities
): readonly DefaultThinkingLevel[] {
  const efforts = knownEfforts(catalogEntry)
  return efforts.length > 0 ? ['auto', ...efforts] : DEFAULT_THINKING_LEVELS
}
