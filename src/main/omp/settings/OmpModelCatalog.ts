import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { modelInputs, RuntimeModelInfo } from '../../../shared/types'
import { modelTokenLimit } from '../../../shared/modelCatalog'
import { detectCli } from '../OmpCapabilities'
import { NativeModelThinking, nativeModelThinking, modelThinkingEfforts } from '../modelThinking'

/**
 * Static model catalog — the preset model names per provider that the
 * Settings dropdowns offer BEFORE any credential exists (omp's own
 * `omp models --json` is credential-filtered and shows nothing keyless).
 *
 * Three layers, in preference order:
 *
 * 1. The installed omp's bundled catalog (`@oh-my-pi/pi-catalog` next to the
 *    CLI) — exactly matches what the local runtime can run. Absent when omp
 *    is a single-file binary without a node_modules tree.
 * 2. A refreshed copy downloaded from the oh-my-pi repo into userData
 *    (`refreshModelCatalog`) — newer than the bundled snapshot.
 * 3. The snapshot bundled with this app (`resources/pi-catalog/models.json`)
 *    — always present, updated when the app itself is rebuilt.
 */

export const CATALOG_URL =
  'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/models.json'

let metadataCache: {
  source: string
  thinking: ReadonlyMap<string, NativeModelThinking>
  models: ReadonlyMap<string, RuntimeModelInfo>
  sorted: RuntimeModelInfo[]
} | undefined

export interface CatalogOrigin {
  origin: 'install' | 'refreshed' | 'bundled'
  path: string
}

interface CatalogEntry {
  id?: unknown
  name?: unknown
  provider?: unknown
  reasoning?: unknown
  baseUrl?: unknown
  api?: unknown
  input?: unknown
  contextWindow?: unknown
  maxTokens?: unknown
  thinking?: unknown
}

/** userData copy written by refreshModelCatalog; injectable for tests. */
export function refreshedCatalogFile(userDataDir?: string): string | null {
  const dir = userDataDir ?? app?.getPath('userData')
  return dir ? join(dir, 'pi-catalog-models.json') : null
}

/** Snapshot shipped inside the app; injectable for tests. */
export function bundledCatalogFile(appPath?: string): string | null {
  const base = appPath ?? app?.getAppPath()
  return base ? join(base, 'resources', 'pi-catalog', 'models.json') : null
}

/** The installed omp's own catalog, when its node_modules tree exists. */
export function findCatalogFile(): string | null {
  const cli = detectCli()
  if (!cli.available || !cli.path) return null
  const rel = join('node_modules', '@oh-my-pi', 'pi-catalog', 'src', 'models.json')
  try {
    let dir = dirname(realpathSync(cli.path))
    for (let i = 0; i < 8; i++) {
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

/** Higher layers take precedence when multiple sources declare the same model. */
function catalogLayers(extra: { userDataDir?: string; appPath?: string } = {}): CatalogOrigin[] {
  const layers: CatalogOrigin[] = []
  const installed = findCatalogFile()
  if (installed) layers.push({ origin: 'install', path: installed })
  const refreshed = refreshedCatalogFile(extra.userDataDir)
  if (refreshed) layers.push({ origin: 'refreshed', path: refreshed })
  const bundled = bundledCatalogFile(extra.appPath)
  if (bundled) layers.push({ origin: 'bundled', path: bundled })
  return layers
}

export async function listOmpModelCatalog(
  providerId?: string,
  extra: { userDataDir?: string; appPath?: string } = {}
): Promise<RuntimeModelInfo[]> {
  const models = nativeMetadata(extra).sorted
  return providerId ? models.filter((m) => m.provider === providerId) : models
}

/** Highest-priority catalog source available ('none' when empty). */
export function catalogOrigin(extra: { userDataDir?: string; appPath?: string } = {}): CatalogOrigin['origin'] | 'none' {
  const layers = catalogLayers(extra)
  for (const layer of layers) {
    if (parseCatalogFile(layer.path)) return layer.origin
  }
  return 'none'
}

/** A newer catalog can add capabilities missing from the installed catalog. */
export function listOmpModelThinking(
  extra: { userDataDir?: string; appPath?: string } = {}
): ReadonlyMap<string, NativeModelThinking> {
  return nativeMetadata(extra).thinking
}

/** Supplemental catalog facts for IDs the runtime actually discovered, e.g. a newer provider model. */
export function listOmpModelCapabilities(
  extra: { userDataDir?: string; appPath?: string } = {}
): ReadonlyMap<string, RuntimeModelInfo> {
  return nativeMetadata(extra).models
}

function nativeMetadata(extra: { userDataDir?: string; appPath?: string }) {
  const layers = catalogLayers(extra)
  const source = layers.map(({ path }) => path).join('\0')
  const useCache = Object.keys(extra).length === 0
  if (useCache && metadataCache?.source === source) return metadataCache
  const thinking = new Map<string, NativeModelThinking>()
  const models = new Map<string, RuntimeModelInfo>()
  // Older discovery entries use false for models they don't recognize. A later
  // layer can supply the concrete capability for the exact provider and ID.
  for (const { path } of layers) {
    for (const model of parseCatalogFile(path, thinking) ?? []) {
      const preferred = models.get(model.selector)
      if (!preferred) models.set(model.selector, model)
      else if (preferred.api === model.api && preferred.baseUrl === model.baseUrl) {
        preferred.input ??= model.input
        preferred.contextWindow ??= model.contextWindow
        preferred.maxTokens ??= model.maxTokens
      }
    }
  }
  const sorted = Array.from(models.values()).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
  const result = { source, thinking, models, sorted }
  if (useCache) metadataCache = result
  return result
}

/** Parse a catalog file; null when missing or not the expected shape. */
function parseCatalogFile(file: string, modelThinking?: Map<string, NativeModelThinking>): RuntimeModelInfo[] | null {
  let parsed: Record<string, Record<string, CatalogEntry>>
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const models: RuntimeModelInfo[] = []
  for (const providerId of Object.keys(parsed)) {
    const byProvider = parsed[providerId]
    if (!byProvider || typeof byProvider !== 'object') continue
    for (const entry of Object.values(byProvider)) {
      const e = entry as CatalogEntry | undefined
      if (!e || typeof e.id !== 'string') continue
      const provider = typeof e.provider === 'string' ? e.provider : providerId
      // Older, provider-less snapshots used a fully qualified ID here.
      const id = e.provider === undefined && e.id.startsWith(`${provider}/`) ? e.id.slice(provider.length + 1) : e.id
      // OMP's models --json format prefixes the entire raw model ID, including
      // its own namespaces (e.g. openrouter/openrouter/auto).
      const selector = `${provider}/${id}`
      if (modelThinking && e.reasoning === true) {
        const config = nativeModelThinking(e.thinking)
        if (config && !modelThinking.has(selector)) modelThinking.set(selector, config)
      }
      models.push({
        provider,
        id,
        selector,
        name: typeof e.name === 'string' ? e.name : e.id,
        input: modelInputs(e.input),
        contextWindow: modelTokenLimit(e.contextWindow),
        maxTokens: modelTokenLimit(e.maxTokens),
        reasoning: e.reasoning === true,
        thinking: modelThinkingEfforts(e.thinking),
        baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : undefined,
        api: typeof e.api === 'string' ? e.api : undefined
      })
    }
  }
  if (models.length === 0) return null
  return models
}

/**
 * Download the latest catalog into userData. Layer 1 (the installed omp's own
 * catalog) still wins afterwards — the runtime can only run what IT knows.
 */
export async function refreshModelCatalog(
  extra: { userDataDir?: string } = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; providers?: number; error?: string }> {
  const target = refreshedCatalogFile(extra.userDataDir)
  if (!target) return { ok: false, error: 'no userData dir' }
  let text: string
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const res = await fetchImpl(CATALOG_URL, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, error: `download failed (${res.status})` }
    text = await res.text()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  // Validate before replacing the known-good copy: provider map with models.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'downloaded file is not JSON' }
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length < 10
  ) {
    return { ok: false, error: 'downloaded catalog looks wrong' }
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}`
    writeFileSync(tmp, text, 'utf-8')
    renameSync(tmp, target)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  metadataCache = undefined
  return { ok: true, providers: Object.keys(parsed).length }
}
