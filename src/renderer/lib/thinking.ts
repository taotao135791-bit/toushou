import {
  DefaultThinkingLevel,
  DEFAULT_THINKING_LEVELS,
  RuntimeModelInfo,
  SessionThinkingLevel,
  SESSION_THINKING_LEVELS
} from '@shared/types'

/**
 * Session thinking options (composer picker / set_thinking_level / --thinking).
 * Session RPC enum includes `off`. Current profile: filtered by the model's
 * own capability set when the catalog knows it; unknown → full session set.
 * Legacy Pi accepts off..xhigh (no max).
 */
export function sessionThinkingOptionsFor(
  profile: 'current' | 'legacy',
  catalogEntry: Pick<RuntimeModelInfo, 'thinking'> | undefined
): readonly SessionThinkingLevel[] {
  if (profile !== 'current') {
    return SESSION_THINKING_LEVELS.filter((l) => l !== 'max')
  }
  if (catalogEntry && catalogEntry.thinking.length > 0) {
    const supported = new Set(catalogEntry.thinking)
    return SESSION_THINKING_LEVELS.filter((l) => l === 'off' || supported.has(l))
  }
  return SESSION_THINKING_LEVELS
}

/**
 * Default-thinking options for Settings (config `defaultThinkingLevel` enum).
 * This is a DIFFERENT domain from the session enum: `auto` is legal, `off`
 * is not — verified against current Oh My Pi 17.2.12.
 *
 * Capability filtering: when the catalog knows the default model's thinking
 * set and it does not mention `auto`, `auto` is still preserved per the
 * runtime's own semantics (the `auto` classifier is runtime-side); every
 * other level must be explicitly listed by the model. Unknown model → full
 * default set.
 */
export function defaultThinkingOptionsFor(
  catalogEntry?: Pick<RuntimeModelInfo, 'thinking'> | undefined
): readonly DefaultThinkingLevel[] {
  if (!catalogEntry || catalogEntry.thinking.length === 0) return DEFAULT_THINKING_LEVELS
  const supported = new Set(catalogEntry.thinking)
  // `super` keep: auto is a runtime classifier, not a model capability.
  return DEFAULT_THINKING_LEVELS.filter((l) => l === 'auto' || supported.has(l))
}