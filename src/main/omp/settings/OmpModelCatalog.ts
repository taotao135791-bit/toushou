import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { RuntimeModelInfo } from '../../../shared/types'
import { detectCli } from '../OmpCapabilities'

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

let catalogCache: RuntimeModelInfo[] | null = null

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
  thinking?: { efforts?: unknown }
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

/** Layered candidates, first hit wins. */
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
  // Cache only the production path; injected paths (tests) always reload.
  const models =
    Object.keys(extra).length === 0
      ? (catalogCache ??= loadCatalog(catalogLayers()))
      : loadCatalog(catalogLayers(extra))
  return providerId ? models.filter((m) => m.provider === providerId) : models
}

/** Which layer the cached catalog came from ('none' when empty). */
export function catalogOrigin(extra: { userDataDir?: string; appPath?: string } = {}): CatalogOrigin['origin'] | 'none' {
  const layers = catalogLayers(extra)
  for (const layer of layers) {
    if (parseCatalogFile(layer.path)) return layer.origin
  }
  return 'none'
}

function loadCatalog(layers: CatalogOrigin[]): RuntimeModelInfo[] {
  for (const layer of layers) {
    const models = parseCatalogFile(layer.path)
    if (models) return models
  }
  return []
}

/** Parse a catalog file; null when missing or not the expected shape. */
function parseCatalogFile(file: string): RuntimeModelInfo[] | null {
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
      const selector = e.id.includes('/') ? e.id : `${provider}/${e.id}`
      const efforts =
        e.thinking && typeof e.thinking === 'object'
          ? ((e.thinking as { efforts?: unknown }).efforts ?? [])
          : []
      models.push({
        provider,
        id: e.id.slice(e.id.lastIndexOf('/') + 1),
        selector,
        name: typeof e.name === 'string' ? e.name : e.id,
        reasoning: e.reasoning === true,
        thinking: Array.isArray(efforts)
          ? (efforts as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
        baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : undefined,
        api: typeof e.api === 'string' ? e.api : undefined
      })
    }
  }
  if (models.length === 0) return null
  return models.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)
  )
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
  catalogCache = null
  return { ok: true, providers: Object.keys(parsed).length }
}
