import type { AdsCopyModelProvider } from './AdsCopyModelStore'

/**
 * One completion call against a user-configured copy model. Protocol shapes:
 * 'openai' → POST {base}/chat/completions; 'anthropic' → POST {base}/v1/messages.
 * The caller owns the fetch implementation (proxy-aware session in Main, a
 * stub in tests) — keys stay in Main and never reach the agent process.
 */
export type CopyFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

export interface CopyCallResult {
  ok: boolean
  text?: string
  error?: string
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`
}

/**
 * Relay-station base URLs arrive in every shape ("https://x.com",
 * "…/v1/", "…/v1/chat/completions"). Normalize ONCE for all call paths:
 * strip known endpoint suffixes, then ensure a trailing /v1 — so a base
 * saved without /v1 no longer passes discovery and then 404s on generation.
 */
export function normalizeBaseUrl(rawBase: string): string {
  let base = rawBase.trim().replace(/\/+$/, '')
  base = base.replace(/\/(chat\/completions|completions|messages|models)$/i, '')
  base = base.replace(/\/v\d+$/i, '')
  return `${base}/v1`
}

export async function callCopyModel(
  fetchImpl: CopyFetch,
  provider: AdsCopyModelProvider,
  request: { system?: string; prompt: string; maxTokens?: number; temperature?: number }
): Promise<CopyCallResult> {
  const maxTokens = Math.min(Math.max(request.maxTokens ?? 3000, 16), 8192)
  const base = normalizeBaseUrl(provider.baseUrl)
  // Sampling defaults from the factory tool's tuned values; DeepSeek relays
  // are more reliable with an explicit JSON contract when the caller asks.
  const isDeepSeek = /deepseek/i.test(provider.model)
  try {
    if (provider.protocol === 'anthropic') {
      const response = await fetchImpl(joinUrl(base, '/messages'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: maxTokens,
          temperature: request.temperature ?? 0.9,
          top_p: 0.92,
          ...(request.system ? { system: request.system } : {}),
          messages: [{ role: 'user', content: request.prompt }]
        })
      })
      if (!response.ok) return { ok: false, error: `http-${response.status}` }
      const data = JSON.parse(await response.text()) as {
        content?: Array<{ type?: string; text?: string }>
        choices?: Array<{ message?: { content?: string } }>
      }
      const text =
        (data.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('')
          .trim() ||
        // Some relays answer the anthropic shape with an OpenAI body.
        (data.choices?.[0]?.message?.content ?? '').trim()
      return text ? { ok: true, text } : { ok: false, error: 'empty-response' }
    }
    const response = await fetchImpl(joinUrl(base, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxTokens,
        temperature: request.temperature ?? (isDeepSeek ? 0.95 : 0.9),
        top_p: 0.92,
        ...(isDeepSeek ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          ...(request.system ? [{ role: 'system', content: request.system }] : []),
          { role: 'user', content: request.prompt }
        ]
      })
    })
    if (!response.ok) return { ok: false, error: `http-${response.status}` }
    const data = JSON.parse(await response.text()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
    }
    const text = (data.choices?.[0]?.message?.content ?? data.choices?.[0]?.message?.reasoning_content ?? '').trim()
    return text ? { ok: true, text } : { ok: false, error: 'empty-response' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `network: ${error.message}`.slice(0, 160) : 'network-error' }
  }
}

/** Stable pool assignment: the same agent (product) always lands on the same model. */
export function pickStablePoolMember<T>(pool: readonly T[], agentKey: string): T | null {
  if (pool.length === 0) return null
  let hash = 0
  for (const char of agentKey) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return pool[hash % pool.length]
}

/**
 * Model discovery for relay stations (中转站): GET the provider's model list so
 * the user picks a real id instead of typing a guess. Both protocols answer
 * { data: [{ id }] } (OpenAI-compatible /models; Anthropic /v1/models).
 */
export async function discoverModels(
  fetchImpl: CopyFetch,
  provider: { baseUrl: string; protocol: 'openai' | 'anthropic'; apiKey: string }
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const url = joinUrl(normalizeBaseUrl(provider.baseUrl), '/models')
  const headers: Record<string, string> =
    provider.protocol === 'anthropic'
      ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${provider.apiKey}` }
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, body: '' })
    if (!response.ok) return { ok: false, error: `http-${response.status}` }
    const data = JSON.parse(await response.text()) as { data?: Array<{ id?: unknown }> }
    if (!Array.isArray(data.data)) return { ok: false, error: 'unexpected-format' }
    const models = data.data
      .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter((id) => id.length > 0 && id.length <= 200)
      .slice(0, 500)
    return models.length > 0 ? { ok: true, models } : { ok: false, error: 'empty-list' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `network: ${error.message}`.slice(0, 160) : 'network-error' }
  }
}
