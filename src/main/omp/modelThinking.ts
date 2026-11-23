import { SESSION_THINKING_LEVELS, SessionThinkingLevel } from '../../shared/types'

type Effort = Exclude<SessionThinkingLevel, 'off'>
const EFFORTS = SESSION_THINKING_LEVELS.filter((level): level is Effort => level !== 'off')
const MODES = ['effort', 'budget', 'google-level', 'anthropic-adaptive', 'anthropic-budget-effort'] as const

export interface NativeModelThinking {
  mode: typeof MODES[number]
  efforts: Effort[]
  defaultLevel?: Effort
  effortMap?: Partial<Record<Effort, string>>
  supportsDisplay?: boolean
}

export function modelThinkingEfforts(value: unknown): Effort[] {
  const advertised = Array.isArray(value) ? value : record(value)?.efforts
  return Array.isArray(advertised) ? EFFORTS.filter((level) => advertised.includes(level)) : []
}

export function nativeModelThinking(value: unknown): NativeModelThinking | undefined {
  const config = record(value)
  const mode = MODES.find((candidate) => candidate === config?.mode)
  const efforts = modelThinkingEfforts(config)
  if (!mode || !config || efforts.length === 0) return undefined
  const defaultLevel = efforts.find((level) => level === config.defaultLevel)
  const mappings = record(config.effortMap)
  const effortMap: NativeModelThinking['effortMap'] = {}
  for (const level of EFFORTS) {
    const mapping = mappings?.[level]
    if (typeof mapping === 'string' && /^[a-z0-9_-]{1,32}$/i.test(mapping)) effortMap[level] = mapping
  }
  return {
    mode,
    efforts,
    ...(defaultLevel ? { defaultLevel } : {}),
    ...(Object.keys(effortMap).length > 0 ? { effortMap } : {}),
    ...(typeof config.supportsDisplay === 'boolean' ? { supportsDisplay: config.supportsDisplay } : {})
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
