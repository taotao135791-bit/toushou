/**
 * Relay-station connection-block paste parsing (newapi/one-api exports):
 * fenced or bare JSON carrying the key and base URL under any common alias.
 * Pure parser — no network, no storage.
 */
export interface RelayBlockResult {
  baseUrl?: string
  apiKey?: string
  model?: string
  protocol?: 'openai' | 'anthropic'
}

const URL_KEYS = ['base_url', 'baseUrl', 'url', 'api_url', 'apiUrl', 'endpoint', 'api_base', 'apiBase']
const KEY_KEYS = ['key', 'api_key', 'apiKey', 'token', 'secret', 'api_token', 'apiToken', 'sk']

export function parseRelayBlock(raw: string): RelayBlockResult | null {
  const text = raw.trim()
  if (!text) return null
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text]
  const candidate = (jsonMatch[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const pick = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
  }
  const baseUrl = pick(URL_KEYS)
  const apiKey = pick(KEY_KEYS)
  const rawModel = parsed['model'] ?? parsed['models']
  const model =
    typeof rawModel === 'string' && rawModel.trim()
      ? rawModel.trim()
      : Array.isArray(rawModel) && typeof rawModel[0] === 'string' && rawModel[0].trim()
        ? rawModel[0].trim()
        : undefined
  if (!baseUrl && !apiKey) return null
  const looksAnthropic = /anthropic/i.test(baseUrl ?? '') || (apiKey ?? '').startsWith('sk-ant-')
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    protocol: looksAnthropic ? 'anthropic' : 'openai'
  }
}
