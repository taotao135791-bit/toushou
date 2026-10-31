import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, '')
  }
}))

import { dispatch, type AdsCopyDispatchDeps } from '../adsCopyBridge'
import type { AdsCopyModelPool, AdsCopyModelProvider } from '../integrations/adscopy/AdsCopyModelStore'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adscopy-bridge-'))
  userDataDir = dir
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows locks — the OS cleans temp dirs.
  }
})


const provider = (name: string, model: string): AdsCopyModelProvider => ({
  id: `id-${name}`, name, baseUrl: 'https://relay.example.com/v1', protocol: 'openai', model, apiKey: 'sk-x', createdAt: 0
})

const poolOf = (providers: AdsCopyModelProvider[], pool: string[], mode: 'chat' | 'pool' = 'pool'): AdsCopyModelPool => ({
  providers,
  pool,
  mode
})

const okFetch = (text: string) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: text } }] })
})

describe('dispatch copy_generate_batch', () => {
  const baseRequest = {
    product: { language: 'en', benefits: ['fast transfers', 'low fees'] },
    categories: [{ type: 'short', qty: 3 }],
    agentId: 'miclip'
  }

  it('runs the score-control loop and returns selected items with diagnostics', async () => {
    const members = [provider('a', 'model-a'), provider('b', 'model-b')]
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: okFetch(
        '```json\n{"short":["Discover fast transfers","Get low fees today","Try instant transfers now"],"long":["Transfer money abroad with low fees and instant delivery — install the app and start today."]}\n```'
      ),
      pool: poolOf(members, members.map((m) => m.id))
    }
    const result = await dispatch(
      { action: 'copy_generate_batch', request: { ...baseRequest } },
      deps
    )
    expect(result.ok).toBe(true)
    const short = (result.results as { short: { items: Array<{ text: string }>; fulfilled: boolean } }).short
    expect(short.items).toHaveLength(3)
    expect(short.fulfilled).toBe(true)
    const control = result.score_control as { attempts: number; acceptedShort: number }
    expect(control.attempts).toBeGreaterThanOrEqual(1)
    expect(control.acceptedShort).toBeGreaterThanOrEqual(3)
    const poolInfo = result.provider_pool as { strategy: string; assignedIndex: number }
    expect(poolInfo.strategy).toBe('agent_sticky')
    expect(poolInfo.assignedIndex).toBeGreaterThanOrEqual(0)
  })

  it('retries with provider rotation until fulfilled or attempts exhausted', async () => {
    const members = [provider('a', 'model-a'), provider('b', 'model-b')]
    let calls = 0
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: async () => {
        calls++
        // First round: one weak candidate below every floor; later rounds deliver.
        if (calls <= 1) return okFetch('{"short":["ok"]}')()
        return okFetch('{"short":["Discover fast transfers","Get low fees today","Try instant transfers now","Join free transfers now","Download the transfer app","Start sending money free"]}')()
      },
      pool: poolOf(members, members.map((m) => m.id))
    }
    const result = await dispatch(
      { action: 'copy_generate_batch', request: { ...baseRequest, maxAttempts: 3 } },
      deps
    )
    expect(calls).toBeGreaterThan(1)
    expect(result.ok).toBe(true)
    const history = result.retry_history as Array<{ attempt: number }>
    expect(history.length).toBeLessThanOrEqual(3)
  })

  it('respects chat mode and empty pools with actionable errors', async () => {
    const deps: AdsCopyDispatchDeps = { fetchImpl: okFetch('{}'), pool: poolOf([], [], 'chat') }
    const chatMode = await dispatch({ action: 'copy_generate_batch', request: baseRequest }, deps)
    expect(chatMode.error).toBe('mode-is-chat')
    const empty = await dispatch(
      { action: 'copy_generate_batch', request: baseRequest },
      { ...deps, pool: poolOf([], [], 'pool') }
    )
    expect(empty.error).toBe('pool-empty')
  })
})
