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

  it('stops after two fruitless rounds instead of burning every attempt', async () => {
    const members = [provider('a', 'model-a')]
    let calls = 0
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: async () => {
        calls++
        return okFetch('{"short":["ok"]}')()
      },
      pool: poolOf(members, members.map((m) => m.id))
    }
    const result = await dispatch(
      { action: 'copy_generate_batch', request: { ...baseRequest, maxAttempts: 5 } },
      deps
    )
    expect(calls).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no-copy-passed')
    expect((result.score_control as { stagnated: boolean }).stagnated).toBe(true)
    expect((result.diagnosis as { dominant: string }).dominant).toBeTruthy()
    expect(Array.isArray(result.next_steps)).toBe(true)
  })

  it('gives the model the real scoring rubric and changes direction on retry', async () => {
    const members = [provider('a', 'model-a')]
    const prompts: string[] = []
    let call = 0
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> }
        prompts.push(body.messages[body.messages.length - 1].content)
        call++
        if (call === 1) return okFetch('{"short":["Transfer money fast"]}')()
        return okFetch('{"short":["Discover fast transfers now","Get low fees today","Try instant transfers now"]}')()
      },
      pool: poolOf(members, members.map((m) => m.id))
    }
    await dispatch({ action: 'copy_generate_batch', request: { ...baseRequest, maxAttempts: 2 } }, deps)
    // The first prompt states the exact floors and the lexicon the scorer uses.
    expect(prompts[0]).toContain('钩子 Hook ≥6 分')
    expect(prompts[0]).toContain('discover')
    expect(prompts[0]).toContain('19–25 字节')
    expect(prompts[0]).toContain('达标')
    // The retry must switch angle and be told what already failed.
    expect(prompts[1]).toContain('换角度')
    expect(prompts[1]).toContain('已被淘汰')
    expect(prompts[1]).toContain('Transfer money fast')
  })

  it('drops a pinned provider that keeps failing and finishes on the rest of the pool', async () => {
    const members = [provider('a', 'model-a'), provider('b', 'model-b')]
    let aCalls = 0
    let bCalls = 0
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: async (_url, init) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model
        if (model === 'model-a') {
          aCalls++
          // 200 with no content block — what thinking-only truncation looks like.
          return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [] }) }
        }
        bCalls++
        return okFetch('{"short":["Discover fast transfers","Get low fees today","Try instant transfers now"]}')()
      },
      pool: poolOf(members, members.map((m) => m.id))
    }
    // agentId pins the job to model-a (members[0]); the fallback must move on.
    const result = await dispatch(
      { action: 'copy_generate_batch', request: { ...baseRequest, maxAttempts: 3 } },
      deps
    )
    expect(result.ok).toBe(true)
    expect(bCalls).toBeGreaterThan(0)
    expect(aCalls).toBeLessThanOrEqual(2)
    expect((result.provider_pool as { strategy: string }).strategy).toContain('fallback')
  })

  it('cancels slow models as soon as the quota is covered', async () => {
    const members = [provider('slow', 'model-slow'), provider('fast', 'model-fast')]
    let aborted = false
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: (_url, init) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model
        if (model === 'model-slow') {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          })
        }
        return Promise.resolve(okFetch('{"short":["Discover fast transfers","Get low fees today","Try instant transfers now"]}')())
      },
      pool: poolOf(members, members.map((m) => m.id))
    }
    // No agentId: the whole pool runs concurrently, so the fast model can
    // finish the quota and cancel the slow one.
    const result = await dispatch(
      {
        action: 'copy_generate_batch',
        request: { product: { language: 'en', benefits: ['fast transfers', 'low fees'] }, categories: [{ type: 'short', qty: 3 }] }
      },
      deps
    )
    expect(result.ok).toBe(true)
    expect(aborted).toBe(true)
  })

  it('never substitutes another model when the caller names one', async () => {
    const members = [provider('a', 'model-a'), provider('b', 'model-b')]
    let bCalls = 0
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: async (_url, init) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model
        if (model === 'model-b') {
          bCalls++
          return okFetch('{"short":["Discover fast transfers","Get low fees today","Try instant transfers now"]}')()
        }
        // The named model returns nothing usable; the run must fail rather
        // than deliver model-b's copy under model-a's name.
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [] }) }
      },
      pool: poolOf(members, members.map((m) => m.id))
    }
    const result = await dispatch(
      { action: 'copy_generate_batch', request: { ...baseRequest, model: 'a', maxAttempts: 3 } },
      deps
    )
    expect(result.ok).toBe(false)
    expect(bCalls).toBe(0)
  })

  it('does not let duplicated lines fake a covered quota', async () => {
    const members = [provider('a', 'model-a'), provider('b', 'model-b')]
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: async (_url, init) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model
        if (model === 'model-a') {
          // The same accepted line five times: one unique candidate, not five.
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ short: Array(5).fill('Discover fast transfers') }) } }] })
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 40))
        return okFetch('{"short":["Get low fees today","Try instant transfers now","Join free transfers now"]}')()
      },
      pool: poolOf(members, members.map((m) => m.id))
    }
    const result = await dispatch(
      {
        action: 'copy_generate_batch',
        request: { product: { language: 'en', benefits: ['fast transfers', 'low fees'] }, categories: [{ type: 'short', qty: 3 }] }
      },
      deps
    )
    expect(result.fulfilled).toBe(true)
    expect((result.results as { short: { items: unknown[] } }).short.items).toHaveLength(3)
  })

  it('reports fulfilled=false plus a diagnosis when delivery is short', async () => {
    const members = [provider('a', 'model-a')]
    const deps: AdsCopyDispatchDeps = {
      fetchImpl: okFetch('{"short":["Discover fast transfers"]}'),
      pool: poolOf(members, members.map((m) => m.id))
    }
    const result = await dispatch(
      {
        action: 'copy_generate_batch',
        request: { product: { language: 'en', benefits: ['fast transfers'] }, categories: [{ type: 'short', qty: 3 }], maxAttempts: 1 }
      },
      deps
    )
    expect(result.ok).toBe(true)
    expect(result.fulfilled).toBe(false)
    expect(result.incomplete).toEqual({ short: 2, long: 0 })
    expect(result.diagnosis).toBeTruthy()
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
