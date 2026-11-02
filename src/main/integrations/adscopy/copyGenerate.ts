import type { AdsCopyModelProvider } from './AdsCopyModelStore'

/**
 * One completion call against a user-configured copy model. Protocol shapes:
 * 'openai' → POST {base}/chat/completions; 'anthropic' → POST {base}/v1/messages.
 * The caller owns the fetch implementation (proxy-aware session in Main, a
 * stub in tests) — keys stay in Main and never reach the agent process.
 */
export type CopyFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
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

/** Relay errors often arrive as HTTP 200 with an {error} body — surface them. */
function apiErrorMessage(error: unknown): string | null {
  if (!error) return null
  if (typeof error === 'string') return error.slice(0, 160)
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 160)
  }
  return 'unknown-api-error'
}

export async function callCopyModel(
  fetchImpl: CopyFetch,
  provider: AdsCopyModelProvider,
  request: {
    system?: string
    prompt: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
    timeoutMs?: number
  }
): Promise<CopyCallResult> {
  const maxTokens = Math.min(Math.max(request.maxTokens ?? 3000, 16), 8192)
  const base = normalizeBaseUrl(provider.baseUrl)
  // Sampling defaults from the factory tool's tuned values; DeepSeek relays
  // are more reliable with an explicit JSON contract when the caller asks.
  const isDeepSeek = /deepseek/i.test(provider.model)
  // Cancellation: the batch engine aborts stragglers once enough candidates
  // are accepted, and every call has its own budget so one slow model cannot
  // hold the whole round hostage.
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  request.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = request.timeoutMs && request.timeoutMs > 0 ? setTimeout(() => controller.abort(), request.timeoutMs) : null
  try {
    if (provider.protocol === 'anthropic') {
      const response = await fetchImpl(joinUrl(base, '/messages'), {
        method: 'POST',
        signal: controller.signal,
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
        error?: unknown
        stop_reason?: string
      }
      const apiError = apiErrorMessage(data.error)
      if (apiError) return { ok: false, error: `api-error: ${apiError}` }
      const text =
        (data.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('')
          .trim() ||
        // Some relays answer the anthropic shape with an OpenAI body.
        (data.choices?.[0]?.message?.content ?? '').trim()
      if (text) return { ok: true, text }
      // Thinking models (opus-5+/sonnet-5.5) may spend the whole budget on
      // reasoning and return no text block — say so instead of a mute 'empty'.
      const thinkingOnly = (data.content ?? []).some((block) => block.type === 'thinking')
      const stop = data.stop_reason ? ` (stop=${data.stop_reason})` : ''
      return { ok: false, error: `${thinkingOnly ? 'thinking-only' : 'empty-response'}${stop}` }
    }
    const response = await fetchImpl(joinUrl(base, '/chat/completions'), {
      method: 'POST',
      signal: controller.signal,
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
      choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>
      error?: unknown
    }
    const apiError = apiErrorMessage(data.error)
    if (apiError) return { ok: false, error: `api-error: ${apiError}` }
    const text = (data.choices?.[0]?.message?.content ?? data.choices?.[0]?.message?.reasoning_content ?? '').trim()
    if (text) return { ok: true, text }
    const finish = data.choices?.[0]?.finish_reason ? ` (stop=${data.choices?.[0]?.finish_reason})` : ''
    return { ok: false, error: `empty-response${finish}` }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: request.signal?.aborted ? 'aborted' : 'timeout' }
    }
    return { ok: false, error: error instanceof Error ? `network: ${error.message}`.slice(0, 160) : 'network-error' }
  } finally {
    if (timer) clearTimeout(timer)
    request.signal?.removeEventListener('abort', abortFromCaller)
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
    // GET carries no body (spec-illegal bodies make some relays reject).
    const response = await fetchImpl(url, { method: 'GET', headers })
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
