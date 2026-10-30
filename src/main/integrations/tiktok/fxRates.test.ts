import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let userDataDir: string
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))
// proxySessionFetch is only the default transport; tests inject fetchImpl.
vi.mock('./proxyFetch', () => ({ proxySessionFetch: async () => { throw new Error('not needed') } }))

import { getUsdRates, resetFxRatesForTest } from './fxRates'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fx-'))
  userDataDir = dir
  resetFxRatesForTest()
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows locks — the OS cleans temp dirs.
  }
})

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response

describe('getUsdRates', () => {
  it('inverts per-USD quotes into currency→USD multipliers', async () => {
    const quotes: Record<string, number> = { USD: 1, MXN: 20, EUR: 0.9, JPY: 150 }
    for (let i = 0; i < 12; i++) quotes[`X${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`] = 1 + i
    const rates = await getUsdRates(async () => okResponse({ result: 'success', rates: quotes }))
    expect(rates).not.toBeNull()
    expect(rates!['MXN']).toBeCloseTo(0.05, 6)
    expect(rates!['EUR']).toBeCloseTo(1 / 0.9, 6)
    expect(rates!['JPY']).toBeCloseTo(1 / 150, 8)
    expect(rates!['USD']).toBeUndefined()
  })

  it('falls back to the disk cache when the source fails', async () => {
    writeFileSync(
      path.join(dir, 'fx-rates.json'),
      JSON.stringify({ at: Date.now(), rates: { MXN: 0.05 } }),
      'utf8'
    )
    const rates = await getUsdRates(async () => ({ ok: false, status: 503, text: async () => '' }) as unknown as Response)
    expect(rates).toEqual({ MXN: 0.05 })
  })

  it('returns null when nothing is available', async () => {
    const rates = await getUsdRates(async () => {
      throw new Error('offline')
    })
    expect(rates).toBeNull()
  })
})
