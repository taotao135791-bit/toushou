import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { proxySessionFetch } from './proxyFetch'

/**
 * USD conversion rates for board money widgets: currency → USD multiplier.
 * Source: the open er-api mirror (no key); a MONTHLY refresh is plenty for
 * ad-report conversions (user call), cached in memory and on disk so
 * restarts and offline stretches keep the last rates. Any failure returns
 * the last cache or null — conversion stays hidden, never blocks.
 */
const CACHE_TTL_MS = 30 * 24 * 3600_000
const SOURCE_URL = 'https://open.er-api.com/v6/latest/USD'

export type UsdRates = Record<string, number>

let memory: { at: number; rates: UsdRates } | null = null
let inflight: Promise<UsdRates | null> | null = null

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'fx-rates.json')
}

async function readDiskCache(): Promise<{ at: number; rates: UsdRates } | null> {
  try {
    const raw = JSON.parse(await readFile(cacheFile(), 'utf8')) as { at?: unknown; rates?: unknown }
    if (typeof raw.at !== 'number' || !raw.rates || typeof raw.rates !== 'object') return null
    const rates: UsdRates = {}
    let count = 0
    for (const [code, value] of Object.entries(raw.rates as Record<string, unknown>)) {
      if (/^[A-Z]{3}$/.test(code) && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        rates[code] = value
        count++
      }
    }
    return count > 0 ? { at: raw.at, rates } : null
  } catch {
    return null
  }
}

async function writeDiskCache(entry: { at: number; rates: UsdRates }): Promise<void> {
  try {
    await writeFile(cacheFile(), JSON.stringify(entry), 'utf8')
  } catch {
    // Cache write is best-effort.
  }
}

/** Test-only: drop in-memory caches so each case starts cold. */
export function resetFxRatesForTest(): void {
  memory = null
  inflight = null
}

export async function getUsdRates(fetchImpl?: (url: string) => Promise<Response>): Promise<UsdRates | null> {
  if (memory && Date.now() - memory.at < CACHE_TTL_MS) return memory.rates
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const fetch = fetchImpl ?? (await proxySessionFetch())
      const response = await fetch(SOURCE_URL)
      if (!response.ok) throw new Error(`http-${response.status}`)
      const data = JSON.parse(await response.text()) as { result?: unknown; rates?: Record<string, unknown> }
      if (data.result !== 'success' || !data.rates || typeof data.rates !== 'object') throw new Error('bad-payload')
      const rates: UsdRates = {}
      for (const [code, perUsd] of Object.entries(data.rates)) {
        if (code !== 'USD' && /^[A-Z]{3}$/.test(code) && typeof perUsd === 'number' && Number.isFinite(perUsd) && perUsd > 0) {
          rates[code] = 1 / perUsd
        }
      }
      if (Object.keys(rates).length < 10) throw new Error('thin-payload')
      memory = { at: Date.now(), rates }
      await writeDiskCache(memory)
      return rates
    } catch {
      const disk = await readDiskCache()
      if (disk) {
        memory = disk
        return disk.rates
      }
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}
