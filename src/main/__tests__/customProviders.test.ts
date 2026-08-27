import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { CustomProviderSpec } from '../../shared/types'
import { CliRunner } from '../omp/settings/OmpConfigCli'

// customProviders.ts imports ./omp for the default runner's CLI detection —
// the tests always inject an explicit modelsFile + runner, so stub it out.
vi.mock('../omp', () => ({
  detectCli: () => ({ command: 'omp', path: '/usr/local/bin/omp', available: true })
}))

import {
  clearProviderKey,
  deleteCustomProvider,
  listCustomProviders,
  sanitizeCustomProviderSpec,
  saveCustomProvider,
  saveProviderKey
} from '../customProviders'

let dir: string
let modelsFile: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-custom-providers-'))
  modelsFile = path.join(dir, 'models.yml')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function spec(patch: Partial<CustomProviderSpec> = {}): CustomProviderSpec {
  return {
    id: 'my-gateway',
    baseUrl: 'https://api.example.com/v1',
    api: 'openai-completions',
    apiKey: 'sk-test-123',
    authNone: false,
    discovery: false,
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 128000, maxTokens: 16384 }],
    ...patch
  }
}

/** Runner that reports the given provider ids in `omp models --json`. */
function verifyRunner(providers: string[], ok = true): CliRunner {
  return async (args) => {
    expect(args).toEqual(['models', '--json'])
    return {
      ok,
      stdout: ok ? JSON.stringify({ models: providers.map((p) => ({ provider: p, id: 'm' })) }) : '',
      stderr: ok ? '' : 'boom'
    }
  }
}

function readDoc(): Record<string, Record<string, unknown>> {
  const parsed = YAML.parse(readFileSync(modelsFile, 'utf-8')) as {
    providers: Record<string, Record<string, unknown>>
  }
  return parsed.providers
}

describe('save → list round-trip', () => {
  it('saves a provider and lists it back without the key material', async () => {
    const r = await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    expect(r).toEqual({ ok: true, verified: true })

    const entry = readDoc()['my-gateway']
    expect(entry.baseUrl).toBe('https://api.example.com/v1')
    expect(entry.api).toBe('openai-completions')
    expect(entry.apiKey).toBe('sk-test-123')
    expect(entry.models).toEqual([
      { id: 'model-a', name: 'Model A', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384 }
    ])

    const list = listCustomProviders({ modelsFile })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.providers).toHaveLength(1)
    const p = list.providers[0]
    expect(p).toMatchObject({
      id: 'my-gateway',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      hasKey: true,
      authNone: false,
      discovery: false,
      models: [{ id: 'model-a', name: 'Model A', contextWindow: 128000, maxTokens: 16384 }],
      source: 'custom'
    })
    // The key must NEVER leave the main process.
    expect(JSON.stringify(list.providers)).not.toContain('sk-test-123')
  })

  it('defaults a missing model name to the id', async () => {
    const r = await saveCustomProvider(
      spec({ models: [{ id: 'model-b', name: '' }] }),
      { modelsFile, runner: verifyRunner(['my-gateway']) }
    )
    expect(r).toEqual({ ok: true, verified: true })
    expect(readDoc()['my-gateway'].models).toEqual([
      { id: 'model-b', name: 'model-b', reasoning: false, input: ['text'] }
    ])
  })

  it('round-trips a no-key local provider with discovery', async () => {
    const r = await saveCustomProvider(
      spec({ id: 'local-llm', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: undefined, authNone: true, discovery: true, models: [] }),
      { modelsFile, runner: verifyRunner(['local-llm']) }
    )
    expect(r).toEqual({ ok: true, verified: true })
    const entry = readDoc()['local-llm']
    expect(entry.auth).toBe('none')
    expect(entry.apiKey).toBeUndefined()
    expect(entry.discovery).toEqual({ type: 'openai-models-list' })
    expect(entry.models).toBeUndefined()
    const list = listCustomProviders({ modelsFile })
    if (list.ok) {
      expect(list.providers[0]).toMatchObject({ hasKey: false, authNone: true, discovery: true, models: [] })
    } else {
      expect.unreachable()
    }
  })

  it('upserts one provider while preserving other entries verbatim', async () => {
    writeFileSync(
      modelsFile,
      YAML.stringify({
        providers: {
          'other-one': { baseUrl: 'https://other.example.com', apiKey: 'sk-other', models: [{ id: 'x', name: 'X' }] }
        }
      })
    )
    const r = await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway', 'other-one']) })
    expect(r.ok).toBe(true)
    const doc = readDoc()
    expect(doc['other-one']).toEqual({
      baseUrl: 'https://other.example.com',
      apiKey: 'sk-other',
      models: [{ id: 'x', name: 'X' }]
    })
    expect(doc['my-gateway']).toBeDefined()
  })

  it('keeps the existing key when editing without a new one', async () => {
    await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    const r = await saveCustomProvider(
      spec({ apiKey: undefined, baseUrl: 'https://api2.example.com/v1' }),
      { modelsFile, runner: verifyRunner(['my-gateway']) }
    )
    expect(r.ok).toBe(true)
    const entry = readDoc()['my-gateway']
    expect(entry.apiKey).toBe('sk-test-123')
    expect(entry.baseUrl).toBe('https://api2.example.com/v1')
  })
})

describe('spec validation', () => {
  const rejects: Array<[string, CustomProviderSpec, string]> = [
    ['bad id', spec({ id: 'My Gateway!' }), 'invalid-id'],
    ['flag-shaped id', spec({ id: '-evil' }), 'invalid-id'],
    ['remote http baseUrl', spec({ baseUrl: 'http://api.example.com/v1' }), 'invalid-base-url'],
    ['non-url baseUrl', spec({ baseUrl: 'api.example.com' }), 'invalid-base-url'],
    ['baseUrl with spaces', spec({ baseUrl: 'https://api.exam ple.com' }), 'invalid-base-url'],
    ['unknown api', spec({ api: 'google-generative-ai' as never }), 'invalid-api'],
    ['empty key', spec({ apiKey: '   ' }), 'invalid-api-key'],
    ['key over 1000 chars', spec({ apiKey: 'k'.repeat(1001) }), 'invalid-api-key'],
    ['key with newline', spec({ apiKey: 'sk-a\nb' }), 'invalid-api-key'],
    ['no key and not auth-none', spec({ apiKey: undefined }), 'invalid-api-key'],
    ['no models without discovery', spec({ models: [] }), 'invalid-models'],
    ['discovery AND models', spec({ discovery: true, models: [{ id: 'a', name: 'A' }] }), 'invalid-models'],
    ['model without id', spec({ models: [{ id: ' ', name: 'A' }] }), 'invalid-models'],
    ['zero contextWindow', spec({ models: [{ id: 'a', name: 'A', contextWindow: 0 }] }), 'invalid-models'],
    ['negative maxTokens', spec({ models: [{ id: 'a', name: 'A', maxTokens: -1 }] }), 'invalid-models'],
    ['fractional contextWindow', spec({ models: [{ id: 'a', name: 'A', contextWindow: 1.5 }] }), 'invalid-models']
  ]

  it.each(rejects)('rejects %s before touching disk', async (_name, bad, code) => {
    const r = await saveCustomProvider(bad, { modelsFile, runner: verifyRunner(['my-gateway']) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(code)
    expect(existsSync(modelsFile)).toBe(false)
  })

  it('accepts loopback http baseUrls', async () => {
    for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://localhost:8080']) {
      const r = await saveCustomProvider(
        spec({ id: 'local-llm', baseUrl, apiKey: undefined, authNone: true }),
        { modelsFile, runner: verifyRunner(['local-llm']) }
      )
      expect(r.ok).toBe(true)
    }
  })
})

describe('runtime verification', () => {
  it('rolls back to the pre-write bytes when omp does not list the provider', async () => {
    writeFileSync(modelsFile, YAML.stringify({ providers: { 'keep-me': { baseUrl: 'https://k.example.com', apiKey: 'k' } } }))
    const before = readFileSync(modelsFile, 'utf-8')
    const r = await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['keep-me']) })
    expect(r).toEqual({ ok: false, error: 'verify-failed' })
    expect(readFileSync(modelsFile, 'utf-8')).toBe(before)
  })

  it('removes the file again when a first-time save fails verification', async () => {
    const r = await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner([]) })
    expect(r).toEqual({ ok: false, error: 'verify-failed' })
    expect(existsSync(modelsFile)).toBe(false)
  })

  it('degrades to verified:false without rollback when the CLI fails', async () => {
    const r = await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner([], false) })
    expect(r).toEqual({ ok: true, verified: false })
    expect(readDoc()['my-gateway']).toBeDefined()
  })

  it('degrades to verified:false when verification is explicitly skipped', async () => {
    const r = await saveCustomProvider(spec(), { modelsFile, runner: null })
    expect(r).toEqual({ ok: true, verified: false })
    expect(readDoc()['my-gateway']).toBeDefined()
  })
})

describe('list honesty', () => {
  it('reports a parse error for broken YAML instead of throwing', () => {
    writeFileSync(modelsFile, 'providers:\n  - [unbalanced')
    const r = listCustomProviders({ modelsFile })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('parse')
  })

  it('reports a shape error for foreign root keys', () => {
    writeFileSync(modelsFile, YAML.stringify({ providers: {}, somethingElse: 1 }))
    const r = listCustomProviders({ modelsFile })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('parse')
  })

  it('returns an empty list when the file does not exist', () => {
    expect(listCustomProviders({ modelsFile })).toEqual({ ok: true, providers: [] })
  })

  it('refuses to overwrite an unparseable file on save', async () => {
    writeFileSync(modelsFile, '{{{')
    const r = await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('parse')
    expect(readFileSync(modelsFile, 'utf-8')).toBe('{{{')
  })
})

describe('delete', () => {
  it('removes only the target provider and keeps an empty map at zero', async () => {
    await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    await saveCustomProvider(spec({ id: 'second', baseUrl: 'https://s.example.com' }), {
      modelsFile,
      runner: verifyRunner(['my-gateway', 'second'])
    })
    expect((await deleteCustomProvider('my-gateway', { modelsFile })).ok).toBe(true)
    let doc = readDoc()
    expect(doc['my-gateway']).toBeUndefined()
    expect(doc['second']).toBeDefined()

    // Last provider out: file stays with an empty providers map (valid for omp).
    expect((await deleteCustomProvider('second', { modelsFile })).ok).toBe(true)
    doc = readDoc()
    expect(doc).toEqual({})
    expect(existsSync(modelsFile)).toBe(true)
  })

  it('is a no-op success for unknown ids and missing files', async () => {
    expect((await deleteCustomProvider('nope', { modelsFile })).ok).toBe(true)
    await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    expect((await deleteCustomProvider('nope', { modelsFile })).ok).toBe(true)
    expect(readDoc()['my-gateway']).toBeDefined()
  })

  it('rejects invalid ids', async () => {
    expect((await deleteCustomProvider('Bad Id', { modelsFile })).ok).toBe(false)
  })
})

describe('sanitizeCustomProviderSpec (IPC boundary)', () => {
  it('whitelists fields and re-types the payload', () => {
    const s = sanitizeCustomProviderSpec({
      id: 'a',
      baseUrl: 'https://x.example.com',
      api: 'openai-completions',
      apiKey: 42, // wrong type — dropped
      authNone: 'yes', // wrong type — coerced false
      discovery: true,
      models: [{ id: 'm', name: 'M', contextWindow: 1000, extra: 'dropped' }],
      hacker: 'ignored'
    })
    expect(s).toEqual({
      id: 'a',
      baseUrl: 'https://x.example.com',
      api: 'openai-completions',
      apiKey: undefined,
      authNone: false,
      discovery: true,
      models: [{ id: 'm', name: 'M', contextWindow: 1000 }]
    })
  })

  it('rejects structurally invalid payloads', () => {
    expect(sanitizeCustomProviderSpec(null)).toBeNull()
    expect(sanitizeCustomProviderSpec('x')).toBeNull()
    expect(sanitizeCustomProviderSpec({ id: 1, baseUrl: 'https://x' })).toBeNull()
    expect(sanitizeCustomProviderSpec({ id: 'a', baseUrl: 'https://x', api: 'nope' })).toBeNull()
    // name is optional (falls back to the id) — but a non-string name is not.
    expect(
      sanitizeCustomProviderSpec({ id: 'a', baseUrl: 'https://x', api: 'openai-completions', models: [{ id: 'm', name: 1 }] })
    ).toBeNull()
    expect(
      sanitizeCustomProviderSpec({ id: 'a', baseUrl: 'https://x', api: 'openai-completions', models: [{ id: 'm' }] })
    ).toMatchObject({ models: [{ id: 'm', name: '' }] })
    expect(
      sanitizeCustomProviderSpec({
        id: 'a',
        baseUrl: 'https://x',
        api: 'openai-completions',
        models: [{ id: 'm', name: 'M', contextWindow: NaN }]
      })
    ).toBeNull()
  })
})

describe('saveProviderKey / clearProviderKey', () => {
  /** Runner that serves both `models --json` verification and logout cleanup. */
  function keyRunner(providers: string[], calls: string[][]): CliRunner {
    return async (args) => {
      calls.push(args)
      if (args[0] === 'auth-broker') return { ok: true, stdout: '', stderr: '' }
      return {
        ok: true,
        stdout: JSON.stringify({ models: providers.map((p) => ({ provider: p, id: 'm' })) }),
        stderr: ''
      }
    }
  }

  it('writes an override-only apiKey entry for a built-in provider', async () => {
    const r = await saveProviderKey('deepseek', 'sk-live-1', {
      modelsFile,
      runner: keyRunner(['deepseek'], [])
    })
    expect(r).toEqual({ ok: true, verified: true })
    expect(readDoc().deepseek).toEqual({ apiKey: 'sk-live-1' })
  })

  it('preserves a custom provider’s other fields when setting its key', async () => {
    await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    const r = await saveProviderKey('my-gateway', 'sk-new', {
      modelsFile,
      runner: keyRunner(['my-gateway'], [])
    })
    expect(r.ok).toBe(true)
    const entry = readDoc()['my-gateway']
    expect(entry.apiKey).toBe('sk-new')
    expect(entry.baseUrl).toBe('https://api.example.com/v1')
    expect(entry.models).toHaveLength(1)
  })

  it('replaces a keyless marker with the real key', async () => {
    await saveCustomProvider(spec({ apiKey: undefined, authNone: true }), {
      modelsFile,
      runner: verifyRunner(['my-gateway'])
    })
    await saveProviderKey('my-gateway', 'sk-new', { modelsFile, runner: keyRunner(['my-gateway'], []) })
    const entry = readDoc()['my-gateway']
    expect(entry.apiKey).toBe('sk-new')
    expect(entry.auth).toBeUndefined()
  })

  it('rolls back when the runtime does not recognize the credential', async () => {
    const r = await saveProviderKey('deepseek', 'sk-x', { modelsFile, runner: keyRunner([], []) })
    expect(r).toMatchObject({ ok: false, error: 'verify-failed' })
    expect(existsSync(modelsFile)).toBe(false)
  })

  it('rejects invalid input without touching disk', async () => {
    expect(await saveProviderKey('BAD ID', 'sk', { modelsFile, runner: null })).toMatchObject({
      ok: false,
      error: 'invalid-id'
    })
    expect(await saveProviderKey('deepseek', '  ', { modelsFile, runner: null })).toMatchObject({
      ok: false,
      error: 'invalid-api-key'
    })
    expect(existsSync(modelsFile)).toBe(false)
  })

  it('clear removes the key and drops an entry that held nothing else', async () => {
    const calls: string[][] = []
    await saveProviderKey('deepseek', 'sk-live-1', { modelsFile, runner: keyRunner(['deepseek'], calls) })
    const r = await clearProviderKey('deepseek', { modelsFile, runner: keyRunner([], calls) })
    expect(r.ok).toBe(true)
    expect(readDoc().deepseek).toBeUndefined()
    // Vault cleanup ran too (earlier login flows may have stored a credential).
    expect(calls.some((c) => c[0] === 'auth-broker' && c[1] === 'logout' && c[2] === 'deepseek')).toBe(true)
  })

  it('clear keeps a custom provider entry, minus the key', async () => {
    await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    const r = await clearProviderKey('my-gateway', { modelsFile, runner: keyRunner([], []) })
    expect(r.ok).toBe(true)
    const entry = readDoc()['my-gateway']
    expect(entry.apiKey).toBeUndefined()
    expect(entry.baseUrl).toBe('https://api.example.com/v1')
  })

  it('clear is a no-op when nothing is stored', async () => {
    const r = await clearProviderKey('deepseek', { modelsFile, runner: keyRunner([], []) })
    expect(r.ok).toBe(true)
  })
})

describe('live key check', () => {
  const fetchAs = (status: number): typeof fetch =>
    (() => Promise.resolve({ status })) as unknown as typeof fetch

  it('rejects a key the provider actively refuses, rolling the file back', async () => {
    await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    const before = readFileSync(modelsFile, 'utf-8')
    const r = await saveProviderKey('my-gateway', 'sk-wrong', {
      modelsFile,
      runner: keyRunnerForLive(['my-gateway']),
      fetchImpl: fetchAs(401)
    })
    expect(r).toMatchObject({ ok: false, error: 'invalid-api-key' })
    expect(readFileSync(modelsFile, 'utf-8')).toBe(before)
  })

  it('saves when the provider answers 200', async () => {
    await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    const r = await saveProviderKey('my-gateway', 'sk-right', {
      modelsFile,
      runner: keyRunnerForLive(['my-gateway']),
      fetchImpl: fetchAs(200)
    })
    expect(r).toEqual({ ok: true, verified: true })
    expect(readDoc()['my-gateway'].apiKey).toBe('sk-right')
  })

  it('never false-negatives: a network error during the live check still saves', async () => {
    await saveCustomProvider(spec(), { modelsFile, runner: verifyRunner(['my-gateway']) })
    const r = await saveProviderKey('my-gateway', 'sk-maybe', {
      modelsFile,
      runner: keyRunnerForLive(['my-gateway']),
      fetchImpl: (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch
    })
    expect(r.ok).toBe(true)
    expect(readDoc()['my-gateway'].apiKey).toBe('sk-maybe')
  })
})

/** Runner for live-check tests (models verification only). */
function keyRunnerForLive(providers: string[]): CliRunner {
  return async () => ({
    ok: true,
    stdout: JSON.stringify({ models: providers.map((p) => ({ provider: p, id: 'm' })) }),
    stderr: ''
  })
}
