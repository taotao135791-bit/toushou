import { describe, expect, it } from 'vitest'
import { callCopyModel, discoverModels, type CopyFetch } from './copyGenerate'
import type { AdsCopyModelProvider } from './AdsCopyModelStore'

const syntheticKey = 'synthetic-private-provider-key-123'
const provider: AdsCopyModelProvider = {
  id: 'synthetic', name: 'Synthetic provider', baseUrl: 'https://synthetic.invalid/v1',
  protocol: 'openai', model: 'synthetic-model', apiKey: syntheticKey, createdAt: 0
}
const jsonResponse = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

describe.each(['openai', 'anthropic'] as const)('copy model safe errors (%s)', protocol => {
  const selected = { ...provider, protocol }

  it('classifies reflected authentication errors without returning provider secrets', async () => {
    for (const error of [
      `Rejected API key ${syntheticKey}`,
      { message: `Rejected API key ${syntheticKey}` },
      { type: 'authentication_error', code: syntheticKey, message: `Header Authorization: ${syntheticKey}` }
    ]) {
      const result = await callCopyModel(async () => jsonResponse({ error }), selected, { prompt: 'Synthetic request' })
      expect(result).toEqual({ ok: false, error: 'api-error: authentication-failed' })
      expect(JSON.stringify(result)).not.toContain(syntheticKey)
    }
  })

  it('returns fixed quota, rate, model and unknown error codes', async () => {
    for (const [error, code] of [
      [{ code: 'insufficient_quota', message: `insufficient quota for ${syntheticKey}` }, 'quota-exceeded'],
      [{ type: 'rate_limit_error', message: `too many requests for ${syntheticKey}` }, 'rate-limited'],
      [{ code: 'model_not_found', message: `model not found for ${syntheticKey}` }, 'model-not-found'],
      [{ message: `upstream detail ${syntheticKey}` }, 'provider-error']
    ] as const) {
      expect(await callCopyModel(async () => jsonResponse({ error }), selected, { prompt: 'Synthetic request' }))
        .toEqual({ ok: false, error: `api-error: ${code}` })
    }
  })

  it('does not return secrets from fetch or body-read exceptions', async () => {
    const fetchFailure: CopyFetch = async () => { throw new Error(`request failed using ${syntheticKey}`) }
    const bodyFailure: CopyFetch = async () => ({ ok: true, status: 200, text: async () => { throw new Error(`response failed using ${syntheticKey}`) } })
    for (const fetch of [fetchFailure, bodyFailure]) {
      expect(await callCopyModel(fetch, selected, { prompt: 'Synthetic request' }))
        .toEqual({ ok: false, error: 'network-error' })
    }
  })

  it('does not return the raw invalid JSON or its parse exception', async () => {
    const result = await callCopyModel(async () => ({ ok: true, status: 200, text: async () => `{"private":"${syntheticKey}"` }), selected, { prompt: 'Synthetic request' })
    expect(result).toEqual({ ok: false, error: 'invalid-response' })
    expect(JSON.stringify(result)).not.toContain(syntheticKey)
  })

  it('does not reflect arbitrary stop reasons while preserving known truncation diagnostics', async () => {
    const payload = (reason: string) => protocol === 'anthropic'
      ? { content: [{ type: 'thinking', thinking: '' }], stop_reason: reason }
      : { choices: [{ message: { content: '' }, finish_reason: reason }] }
    const base = protocol === 'anthropic' ? 'thinking-only' : 'empty-response'
    expect(await callCopyModel(async () => jsonResponse(payload(syntheticKey)), selected, { prompt: 'Synthetic request' }))
      .toEqual({ ok: false, error: base })
    const known = protocol === 'anthropic' ? 'max_tokens' : 'length'
    expect(await callCopyModel(async () => jsonResponse(payload(known)), selected, { prompt: 'Synthetic request' }))
      .toEqual({ ok: false, error: `${base} (stop=${known})` })
  })

  it('preserves successful model output', async () => {
    const text = '{"short":["Discover useful tools"]}'
    const payload = protocol === 'anthropic' ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] }
    expect(await callCopyModel(async () => jsonResponse(payload), selected, { prompt: 'Synthetic request' }))
      .toEqual({ ok: true, text })
  })
})

describe('model discovery safe errors', () => {
  it('does not return a reflected key from network exceptions', async () => {
    expect(await discoverModels(async () => { throw new Error(`Authorization ${syntheticKey}`) }, provider))
      .toEqual({ ok: false, error: 'network-error' })
  })

  it('classifies HTTP 200 relay errors without returning their text', async () => {
    expect(await discoverModels(async () => jsonResponse({ error: { message: `insufficient quota ${syntheticKey}` } }), provider))
      .toEqual({ ok: false, error: 'api-error: quota-exceeded' })
  })
})
