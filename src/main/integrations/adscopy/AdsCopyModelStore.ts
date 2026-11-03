import { app, safeStorage } from 'electron'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SecretBackend } from '../feishu/FeishuCredentialStore'
import { SecureStorageCoordinator, SecureStorageUnavailableError, secureStorageCoordinator } from '../secureStorageCoordinator'

/**
 * 文案模型池的自定义供应商存储 — the same encrypted-envelope pattern as the
 * TikTok/Feishu stores: provider API keys never enter electron-store or the
 * renderer process. This pool is OWNED BY THE ADS-COPY TOOL ONLY; the chat
 * session's own model routing (custom providers for the runtime) is a
 * completely separate mechanism and is never touched from here.
 */
export interface AdsCopyModelProvider {
  id: string
  /** Display name the user calls this provider by (also the agent's selector). */
  name: string
  /** https:// endpoint base — OpenAI-compatible or Anthropic protocol. */
  baseUrl: string
  protocol: 'openai' | 'anthropic'
  model: string
  apiKey: string
  createdAt: number
}

export interface AdsCopyModelPool {
  providers: AdsCopyModelProvider[]
  /** Ordered provider ids forming the concurrent pool. */
  pool: string[]
  /**
   * 'chat' = follow the conversation model (the tool stays out of the way);
   * 'pool' = generate on the user-configured pool. Users switch freely.
   */
  mode: 'chat' | 'pool'
}

const MAX_NAME = 60
const MAX_URL = 300
const MAX_MODEL = 120
const MAX_KEY = 400
/**
 * One relay usually serves dozens of models, so a single provider entry per
 * model needs headroom — 100 entries cost ~40 KB encrypted and keep a whole
 * relay importable in one go.
 */
export const MAX_PROVIDERS = 100

const electronBackend: SecretBackend = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value)
}

export type AdsCopyModelInput = Omit<AdsCopyModelProvider, 'id' | 'createdAt'>

/** Bounded field validation shared by upsert and the IPC layer. */
export function validateAdsCopyModelInput(raw: {
  name?: unknown
  baseUrl?: unknown
  protocol?: unknown
  model?: unknown
  apiKey?: unknown
}): AdsCopyModelInput | { error: string } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  if (!name || name.length > MAX_NAME) return { error: 'invalid-name' }
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || baseUrl.length > MAX_URL) return { error: 'invalid-base-url' }
  } catch { return { error: 'invalid-base-url' } }
  if (raw.protocol !== 'openai' && raw.protocol !== 'anthropic') return { error: 'invalid-protocol' }
  if (!model || model.length > MAX_MODEL) return { error: 'invalid-model' }
  if (!apiKey || apiKey.length > MAX_KEY) return { error: 'invalid-api-key' }
  return { name, baseUrl, protocol: raw.protocol, model, apiKey }
}

/* Identity of a provider, ignoring its display name: two entries with the same
 * protocol, endpoint and model are the same model seen twice. */
function providerKey(provider: { protocol: string; baseUrl: string; model: string }): string {
  // URL normalizes the scheme/host (and default port); relay paths and model
  // identifiers remain case-sensitive. Only ignore trailing endpoint slashes.
  const endpoint = new URL(provider.baseUrl.trim()).toString().replace(/\/+$/, '')
  return JSON.stringify([provider.protocol, endpoint, provider.model.trim()])
}

/** Names are the agent's selector, so a batch must never produce duplicates. */
function uniqueProviderName(base: string, taken: Set<string>): string {
  const trimmed = (base.trim() || 'model').slice(0, MAX_NAME)
  if (!taken.has(trimmed.toLowerCase())) return trimmed
  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` (${index})`
    const candidate = `${trimmed.slice(0, MAX_NAME - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${trimmed.slice(0, MAX_NAME - 7)} (copy)`
}

// All instances targeting one file serialize their complete read-modify-write.
const writes = new Map<string, Promise<void>>()
export class AdsCopyModelStore {
  private readonly filePathOverride?: string
  private readonly backend: SecretBackend
  private readonly coordinator: SecureStorageCoordinator
  private failed: Error | null = null
  private resolvedPath: string | null = null

  constructor(options: { filePath?: string; backend?: SecretBackend; coordinator?: SecureStorageCoordinator } = {}) {
    this.filePathOverride = options.filePath
    this.backend = options.backend ?? electronBackend
    this.coordinator = options.coordinator ?? (options.backend ? new SecureStorageCoordinator() : secureStorageCoordinator)
  }

  /** Resolved lazily so module-level construction never races app.getPath. */
  private get filePath(): string {
    if (!this.resolvedPath) {
      this.resolvedPath = this.filePathOverride ?? path.join(app.getPath('userData'), 'ads-copy-models.bin')
    }
    return this.resolvedPath
  }

  async load(options: { retry?: boolean } = {}): Promise<AdsCopyModelPool> {
    if (this.failed && !options.retry) throw this.failed
    const retryEpoch = options.retry ? this.coordinator.blockedEpoch() : null
    let encoded: string
    try {
      encoded = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.failed = null
        return { providers: [], pool: [], mode: 'chat' }
      }
      // Transient failures (file lock, permissions) must not masquerade as
      // "no providers stored" — the next mutation would wipe the store.
      throw error
    }
    // A single explicit retry may bypass the shared latch; parsing errors
    // below remain local to this file and never disable unrelated stores.
    try {
      const decrypted = this.coordinator.decrypt(this.backend, Buffer.from(encoded, 'base64'), { retry: options.retry === true, retryEpoch })
      const raw = JSON.parse(decrypted) as Record<string, unknown>
      if (!Array.isArray(raw.providers) || !Array.isArray(raw.pool) || (raw.mode !== 'chat' && raw.mode !== 'pool')) throw new Error('invalid-envelope')
      const parsedProviders = (raw.providers as Array<Record<string, unknown>>).map((item) => item && typeof item === 'object' ? this.validateProvider(item) : null)
      if (parsedProviders.some((item) => item === null)) throw new Error('invalid-provider')
      const providers = parsedProviders as AdsCopyModelProvider[]
      if (providers.length > MAX_PROVIDERS || new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error('invalid-provider')
      const known = new Set(providers.map((provider) => provider.id))
      const pool = raw.pool as unknown[]
      if (pool.some(id => typeof id !== 'string' || !known.has(id)) || new Set(pool).size !== pool.length) throw new Error('invalid-pool')
      const poolIds = pool as string[]
      const mode = raw.mode === 'pool' ? 'pool' : 'chat'
      this.failed = null
      return { providers, pool: poolIds, mode }
    } catch (error) {
      // A corrupt envelope cannot prove the pool is empty — refuse instead of
      // letting the next mutation overwrite the user's keys.
      this.failed = error instanceof SecureStorageUnavailableError ? error : new Error('ads-copy model store is unreadable')
      throw this.failed
    }
  }

  private validateProvider(item: Record<string, unknown>): AdsCopyModelProvider | null {
    const checked = validateAdsCopyModelInput(item)
    if ('error' in checked) return null
    if (typeof item.id !== 'string' || !item.id || item.id.length > 60) return null
    return {
      id: item.id,
      name: checked.name,
      baseUrl: checked.baseUrl,
      protocol: checked.protocol,
      model: checked.model,
      apiKey: checked.apiKey,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0
    }
  }

  private async persist(pool: AdsCopyModelPool, retryEpoch: number | null): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    // A user action that began after a shared failure may explicitly retry
    // an initial save; a failure occurring later must not cause a second prompt.
    const encrypted = this.coordinator.encrypt(this.backend, JSON.stringify(pool), { retry: retryEpoch !== null, retryEpoch })
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, encrypted.toString('base64'), { mode: 0o600, flag: 'wx' })
      await chmod(tmp, 0o600)
      await rename(tmp, this.filePath)
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const key = this.filePath
    const previous = writes.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(action)
    const tail = result.then(() => undefined, () => undefined)
    writes.set(key, tail)
    try { return await result } finally { if (writes.get(key) === tail) writes.delete(key) }
  }

  async upsert(input: AdsCopyModelInput, id?: string): Promise<AdsCopyModelPool> {
    const checked = validateAdsCopyModelInput(input)
    if ('error' in checked) throw new Error(checked.error)
    const retryEpoch = this.coordinator.blockedEpoch()
    return this.exclusive(async () => {
      const current = await this.load()
      if (current.providers.length >= MAX_PROVIDERS && !id) {
        throw new Error('provider-limit')
      }
      const now = Date.now()
      if (id) {
        const existing = current.providers.find((provider) => provider.id === id)
        if (!existing) throw new Error('not-found')
        const next: AdsCopyModelPool = {
          providers: current.providers.map((provider) =>
            provider.id === id ? { ...provider, ...checked, id, createdAt: existing.createdAt } : provider
          ),
          pool: current.pool,
          mode: current.mode
        }
        await this.persist(next, retryEpoch)
        return next
      }
      const provider: AdsCopyModelProvider = { id: crypto.randomUUID(), ...checked, createdAt: now }
      const next: AdsCopyModelPool = { providers: [...current.providers, provider], pool: current.pool, mode: current.mode }
      await this.persist(next, retryEpoch)
      return next
    })
  }

  /**
   * Batch add — one relay often serves dozens of models, and each model needs
   * its own provider entry. Existing entries (same protocol + base URL +
   * model) are skipped instead of duplicated, names stay unique (the agent
   * selects a provider BY NAME), and the batch stops at the provider cap with
   * `limitReached` so the UI can report what really happened.
   */
  async addMany(inputs: AdsCopyModelInput[]): Promise<{
    added: number
    skipped: number
    limitReached: boolean
    pool: AdsCopyModelPool
  }> {
    const checked = inputs.map((input) => validateAdsCopyModelInput(input))
    const invalid = checked.find((item): item is { error: string } => 'error' in item)
    if (invalid) throw new Error(invalid.error)
    const valid = checked as AdsCopyModelInput[]
    const retryEpoch = this.coordinator.blockedEpoch()
    return this.exclusive(async () => {
      const current = await this.load()
      const seen = new Set(current.providers.map(providerKey))
      const names = new Set(current.providers.map((provider) => provider.name.toLowerCase()))
      const additions: AdsCopyModelProvider[] = []
      let skipped = 0
      let limitReached = false
      const now = Date.now()
      for (const input of valid) {
        if (current.providers.length + additions.length >= MAX_PROVIDERS) {
          limitReached = true
          break
        }
        const key = providerKey(input)
        if (seen.has(key)) {
          skipped += 1
          continue
        }
        seen.add(key)
        const name = uniqueProviderName(input.name || input.model, names)
        names.add(name.toLowerCase())
        additions.push({ id: randomUUID(), ...input, name, createdAt: now })
      }
      if (additions.length === 0) return { added: 0, skipped, limitReached, pool: current }
      const pool: AdsCopyModelPool = {
        providers: [...current.providers, ...additions],
        pool: current.pool,
        mode: current.mode
      }
      await this.persist(pool, retryEpoch)
      return { added: additions.length, skipped, limitReached, pool }
    })
  }

  async remove(id: string): Promise<AdsCopyModelPool> {    const retryEpoch = this.coordinator.blockedEpoch()
    return this.exclusive(async () => {
      const current = await this.load()
      const next: AdsCopyModelPool = {
        providers: current.providers.filter((provider) => provider.id !== id),
        pool: current.pool.filter((poolId) => poolId !== id),
        mode: current.mode
      }
      await this.persist(next, retryEpoch)
      return next
    })
  }

  async setPool(poolIds: string[]): Promise<AdsCopyModelPool> {
    const retryEpoch = this.coordinator.blockedEpoch()
    return this.exclusive(async () => {
      const current = await this.load()
      const known = new Set(current.providers.map((provider) => provider.id))
      const deduped: string[] = []
      for (const id of poolIds) {
        if (typeof id === 'string' && known.has(id) && !deduped.includes(id)) deduped.push(id)
      }
      const next: AdsCopyModelPool = { providers: current.providers, pool: deduped, mode: current.mode }
      await this.persist(next, retryEpoch)
      return next
    })
  }

  async setMode(mode: 'chat' | 'pool'): Promise<AdsCopyModelPool> {
    const retryEpoch = this.coordinator.blockedEpoch()
    return this.exclusive(async () => {
      const current = await this.load()
      const next: AdsCopyModelPool = { ...current, mode: mode === 'pool' ? 'pool' : 'chat' }
      await this.persist(next, retryEpoch)
      return next
    })
  }


  async clear(): Promise<void> {
    return this.exclusive(async () => {
      try { await unlink(this.filePath) }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error }
    })
  }

  /** Renderer-safe projection: keys never cross the IPC boundary. */
  static mask(pool: AdsCopyModelPool): Array<{
    id: string
    name: string
    baseUrl: string
    protocol: 'openai' | 'anthropic'
    model: string
    inPool: boolean
    createdAt: number
  }> {
    const poolSet = new Set(pool.pool)
    return pool.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: (() => { try { const url = new URL(provider.baseUrl); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString() } catch { return '' } })(),
      protocol: provider.protocol,
      model: provider.model,
      inPool: poolSet.has(provider.id),
      createdAt: provider.createdAt
    }))
  }
}
