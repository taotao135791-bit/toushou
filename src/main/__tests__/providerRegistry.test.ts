import { describe, it, expect } from 'vitest'
import { ProviderRegistry, parseLoginProviders } from '../omp/settings/ProviderRegistry'
import { CliRunner } from '../omp/settings/OmpConfigCli'

/**
 * The provider registry is the Settings dropdown's stable data source:
 * `omp auth-broker list --json` — pure CLI, no runtime spawn, no credentials.
 * These tests pin the defensive parsing contract and the TTL cache.
 */

const PAYLOAD = JSON.stringify([
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openai', name: 'OpenAI' }
])

function runnerOf(res: { ok: boolean; stdout: string }) {
  const calls: string[][] = []
  const run: CliRunner = async (args) => {
    calls.push(args)
    return { ok: res.ok, stdout: res.stdout, stderr: '' }
  }
  return { run, calls }
}

describe('parseLoginProviders', () => {
  it('parses a normal registry payload', () => {
    expect(parseLoginProviders(PAYLOAD)).toEqual([
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'openai', name: 'OpenAI' }
    ])
  })

  it('drops entries without a usable id; missing names fall back to the id', () => {
    const parsed = parseLoginProviders(
      JSON.stringify([
        { id: 'deepseek', name: 'DeepSeek' },
        { name: 'No Id' },
        { id: 42, name: 'Numeric Id' },
        { id: '', name: 'Empty Id' },
        null,
        'garbage',
        { id: 'noname' },
        { id: 'emptyname', name: '' }
      ])
    )
    expect(parsed).toEqual([
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'noname', name: 'noname' },
      { id: 'emptyname', name: 'emptyname' }
    ])
  })

  it('returns null on invalid JSON (contract broken → unknown, never empty)', () => {
    expect(parseLoginProviders('not json')).toBeNull()
    expect(parseLoginProviders('')).toBeNull()
  })

  it('returns null on a non-array payload', () => {
    expect(parseLoginProviders(JSON.stringify({ providers: [] }))).toBeNull()
    expect(parseLoginProviders(JSON.stringify('deepseek'))).toBeNull()
  })
})

describe('ProviderRegistry.list', () => {
  it('runs `auth-broker list --json` and caches within the TTL', async () => {
    const { run, calls } = runnerOf({ ok: true, stdout: PAYLOAD })
    const registry = new ProviderRegistry()
    const first = await registry.list(run)
    const second = await registry.list(run)
    expect(first).toEqual([
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'openai', name: 'OpenAI' }
    ])
    expect(second).toBe(first)
    expect(calls).toEqual([['auth-broker', 'list', '--json']])
  })

  it('returns null when the CLI call fails (→ capability unknown)', async () => {
    const { run } = runnerOf({ ok: false, stdout: '' })
    expect(await new ProviderRegistry().list(run)).toBeNull()
  })

  it('returns null when the payload is unparseable', async () => {
    const { run } = runnerOf({ ok: true, stdout: 'not json' })
    expect(await new ProviderRegistry().list(run)).toBeNull()
  })

  it('refetches after invalidate() and after the TTL expires', async () => {
    const { run, calls } = runnerOf({ ok: true, stdout: PAYLOAD })
    const registry = new ProviderRegistry(0) // ttlMs 0: every call refetches
    await registry.list(run)
    await registry.list(run)
    expect(calls).toHaveLength(2)

    const cached = new ProviderRegistry()
    await cached.list(run)
    cached.invalidate()
    await cached.list(run)
    expect(calls).toHaveLength(4)
  })
})
