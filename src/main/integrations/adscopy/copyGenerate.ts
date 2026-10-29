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

export async function callCopyModel(
  fetchImpl: CopyFetch,
  provider: AdsCopyModelProvider,
  request: { system?: string; prompt: string; maxTokens?: number }
): Promise<CopyCallResult> {
  const maxTokens = Math.min(Math.max(request.maxTokens ?? 1024, 16), 8192)
  try {
    if (provider.protocol === 'anthropic') {
      const response = await fetchImpl(joinUrl(provider.baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: maxTokens,
          ...(request.system ? { system: request.system } : {}),
          messages: [{ role: 'user', content: request.prompt }]
        })
      })
      if (!response.ok) return { ok: false, error: `http-${response.status}` }
      const data = JSON.parse(await response.text()) as { content?: Array<{ type?: string; text?: string }> }
      const text = (data.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('')
        .trim()
      return text ? { ok: true, text } : { ok: false, error: 'empty-response' }
    }
    const response = await fetchImpl(joinUrl(provider.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxTokens,
        messages: [
          ...(request.system ? [{ role: 'system', content: request.system }] : []),
          { role: 'user', content: request.prompt }
        ]
      })
    })
    if (!response.ok) return { ok: false, error: `http-${response.status}` }
    const data = JSON.parse(await response.text()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = (data.choices?.[0]?.message?.content ?? '').trim()
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
