import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PiModel } from '../shared/types'
import { detectCli, executableSearchDirs, drainLines } from './omp'

/**
 * Ask pi itself which models are usable: spawn a short-lived RPC session,
 * send `get_available_models`, read the response, kill the process.
 * pi only lists models whose provider has credentials (auth.json or env),
 * which is exactly the set the GUI should offer.
 *
 * Results are cached briefly — spawning pi costs ~0.5s and the set only
 * changes when keys or pi's registry change.
 */

const CACHE_TTL_MS = 30_000
const QUERY_TIMEOUT_MS = 15_000

let cache: { at: number; models: PiModel[] } | null = null
let inFlight: Promise<PiModel[]> | null = null

/** Drop the cache (e.g. after an API key was added or removed). */
export function invalidateModelCache(): void {
  cache = null
}

/**
 * pi's full built-in model registry, read straight from the pi-ai package
 * shipped inside the pi install — independent of credentials. The settings
 * page uses this so the default-model picker can offer every model a
 * provider supports before a key is stored.
 *
 * The registry file is ESM inside a CJS bundle, so it is loaded with a
 * runtime `import()` hidden from the bundler. Cached for the process
 * lifetime: the registry only changes when pi itself is upgraded.
 */
let catalogCache: PiModel[] | null = null

export async function listCatalogModels(provider?: string): Promise<PiModel[]> {
  if (!catalogCache) catalogCache = await loadCatalog()
  return provider ? catalogCache.filter((m) => m.provider === provider) : catalogCache
}

async function loadCatalog(): Promise<PiModel[]> {
  const file = findRegistryFile()
  if (!file) return []
  try {
    // Indirect import so bundlers leave the runtime dynamic import alone.
    const dynamicImport = new Function('u', 'return import(u)') as (
      u: string
    ) => Promise<{ MODELS?: unknown }>
    const mod = await dynamicImport(pathToFileURL(file).href)
    const registry = mod.MODELS
    if (!registry || typeof registry !== 'object') return []
    const models: PiModel[] = []
    for (const byId of Object.values(registry as Record<string, Record<string, unknown>>)) {
      for (const m of Object.values(byId ?? {})) {
        const entry = m as { id?: unknown; name?: unknown; provider?: unknown; reasoning?: unknown }
        if (typeof entry?.id !== 'string' || typeof entry?.provider !== 'string') continue
        models.push({
          id: entry.id,
          name: typeof entry.name === 'string' ? entry.name : entry.id,
          provider: entry.provider,
          reasoning: Boolean(entry.reasoning)
        })
      }
    }
    return models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/**
 * cli.path is usually a symlink into the pi install
 * (…/node_modules/@earendil-works/pi-coding-agent/dist/cli.js); pi-ai sits
 * in a node_modules directory somewhere above it (nested first, then the
 * install root for hoisted layouts).
 */
function findRegistryFile(): string | null {
  const cli = detectCli()
  if (!cli.available || !cli.path) return null
  const rel = join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'models.generated.js')
  try {
    let dir = dirname(realpathSync(cli.path))
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, rel)
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // fall through
  }
  return null
}

export async function listAvailableModels(): Promise<PiModel[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models
  if (inFlight) return inFlight
  inFlight = queryModels()
    .then((models) => {
      cache = { at: Date.now(), models }
      return models
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

function queryModels(): Promise<PiModel[]> {
  const cli = detectCli()
  if (!cli.available) return Promise.resolve([])

  return new Promise((resolve) => {
    const proc = spawn(cli.path ?? cli.command, ['--mode', 'rpc', '--no-extensions'], {
      env: {
        ...process.env,
        PATH: executableSearchDirs().join(':'),
        HOME: homedir(),
        FORCE_COLOR: '0'
      }
    })

    let buffer = ''
    let done = false
    const finish = (models: PiModel[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.kill()
      resolve(models)
    }
    const timer = setTimeout(() => finish([]), QUERY_TIMEOUT_MS)

    proc.on('error', () => finish([]))
    proc.stdout?.on('data', (chunk: Buffer) => {
      const { lines, rest } = drainLines(buffer, chunk.toString('utf-8'))
      buffer = rest
      for (const line of lines) {
        try {
          const payload = JSON.parse(line)
          if (payload.type !== 'response' || payload.command !== 'get_available_models') continue
          const raw = payload.data?.models ?? payload.data
          if (!payload.success || !Array.isArray(raw)) {
            finish([])
            return
          }
          finish(
            raw
              .filter((m) => m && typeof m.id === 'string' && typeof m.provider === 'string')
              .map((m) => ({
                id: m.id,
                name: typeof m.name === 'string' ? m.name : m.id,
                provider: m.provider,
                reasoning: Boolean(m.reasoning)
              }))
          )
          return
        } catch {
          // partial JSON line — keep buffering
        }
      }
    })
    proc.on('exit', () => finish([]))

    proc.stdin?.write(JSON.stringify({ id: 'models', type: 'get_available_models' }) + '\n')
  })
}
