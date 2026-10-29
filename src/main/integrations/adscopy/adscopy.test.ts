import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The store resolves its default path through electron's app.getPath; point
// it at a fresh temp dir and stub safeStorage with a reversible "cipher".
let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, '')
  }
}))

import { AdsCopyModelStore, validateAdsCopyModelInput } from './AdsCopyModelStore'
import { callCopyModel, pickStablePoolMember } from './copyGenerate'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adscopy-'))
  userDataDir = dir
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows locks — the OS cleans temp dirs.
  }
})

describe('validateAdsCopyModelInput', () => {
  const valid = { name: 'gpt-copy', baseUrl: 'https://api.example.com/v1', protocol: 'openai' as const, model: 'gpt-4o-mini', apiKey: 'sk-x' }
  it('accepts a valid provider', () => {
    expect(validateAdsCopyModelInput(valid)).toEqual(valid)
  })
  it('rejects bad names, non-https urls, bad protocols and empty keys', () => {
    expect(validateAdsCopyModelInput({ ...valid, baseUrl: 'http://insecure' })).toHaveProperty('error', 'invalid-base-url')
    expect(validateAdsCopyModelInput({ ...valid, protocol: 'google' })).toHaveProperty('error', 'invalid-protocol')
    expect(validateAdsCopyModelInput({ ...valid, apiKey: '' })).toHaveProperty('error', 'invalid-api-key')
    expect(validateAdsCopyModelInput({ ...valid, name: '' })).toHaveProperty('error', 'invalid-name')
  })
})

describe('AdsCopyModelStore', () => {
  it('round-trips providers and pool through the encrypted envelope, masks keys', async () => {
    const store = new AdsCopyModelStore()
    const saved = await store.upsert({ name: 'gpt-copy', baseUrl: 'https://api.example.com/v1', protocol: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-secret' })
    expect(saved.providers).toHaveLength(1)
    await store.setPool([saved.providers[0].id])

    const reloaded = await store.load()
    expect(reloaded.providers[0].apiKey).toBe('sk-secret')
    expect(reloaded.pool).toEqual([saved.providers[0].id])

    const masked = AdsCopyModelStore.mask(reloaded)
    expect(JSON.stringify(masked)).not.toContain('sk-secret')
    expect(masked[0].inPool).toBe(true)
  })

  it('removing a provider also drops it from the pool', async () => {
    const store = new AdsCopyModelStore()
    const saved = await store.upsert({ name: 'a', baseUrl: 'https://a.example.com', protocol: 'anthropic', model: 'claude-x', apiKey: 'k' })
    await store.setPool([saved.providers[0].id])
    const after = await store.remove(saved.providers[0].id)
    expect(after.providers).toHaveLength(0)
    expect(after.pool).toHaveLength(0)
  })
})

describe('callCopyModel', () => {
  const provider = {
    id: 'p1', name: 'gpt-copy', baseUrl: 'https://api.example.com/v1', protocol: 'openai' as const,
    model: 'gpt-4o-mini', apiKey: 'sk-secret', createdAt: 0
  }
  const jsonResponse = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body)
  })

  it('speaks OpenAI-compatible chat completions with a bearer key', async () => {
    let seen: { url: string; init: { headers: Record<string, string>; body: string } } | null = null
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen = { url, init }
      return jsonResponse({ choices: [{ message: { content: '  hello ' } }] })
    }
    const result = await callCopyModel(fetchImpl, provider, { prompt: 'hi' })
    expect(result).toEqual({ ok: true, text: 'hello' })
    expect(seen!.url).toBe('https://api.example.com/v1/chat/completions')
    expect(seen!.init.headers.authorization).toBe('Bearer sk-secret')
    expect(JSON.parse(seen!.init.body).messages[0].role).toBe('user')
  })

  it('speaks Anthropic messages with the x-api-key header', async () => {
    const anthropic = { ...provider, protocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com' }
    let seen: { url: string; headers: Record<string, string> } | null = null
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen = { url, headers: init.headers }
      return jsonResponse({ content: [{ type: 'text', text: 'bonjour' }] })
    }
    const result = await callCopyModel(fetchImpl, anthropic, { system: 'be brief', prompt: 'hi' })
    expect(result).toEqual({ ok: true, text: 'bonjour' })
    expect(seen!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen!.headers['x-api-key']).toBe('sk-secret')
    expect(JSON.stringify(seen!.headers)).not.toContain('Bearer')
  })

  it('surfaces http and network failures as stable errors', async () => {
    expect(await callCopyModel(async () => jsonResponse({}, 401), provider, { prompt: 'x' })).toEqual({ ok: false, error: 'http-401' })
    expect(await callCopyModel(async () => jsonResponse({ choices: [] }), provider, { prompt: 'x' })).toEqual({ ok: false, error: 'empty-response' })
    const network = await callCopyModel(
      async () => {
        throw new Error('boom')
      },
      provider,
      { prompt: 'x' }
    )
    expect(network.ok).toBe(false)
    expect(network.error).toContain('network')
  })
})

describe('pickStablePoolMember', () => {
  it('assigns the same member for the same key and cycles across keys', () => {
    const pool = ['a', 'b', 'c']
    expect(pickStablePoolMember(pool, 'miclip')).toBe(pickStablePoolMember(pool, 'miclip'))
    expect(pickStablePoolMember(pool, '')).toBe(pool[0])
    expect(pickStablePoolMember([], 'x')).toBeNull()
    const picks = new Set(['产品一', '产品二', '产品三', '产品四'].map((key) => pickStablePoolMember(pool, key)))
    expect(picks.size).toBeGreaterThan(1)
  })
})
