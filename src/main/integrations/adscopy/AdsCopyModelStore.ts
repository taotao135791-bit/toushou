import { app, safeStorage } from 'electron'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SecretBackend } from '../feishu/FeishuCredentialStore'

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
const MAX_PROVIDERS = 20

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
  if (!/^https:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > MAX_URL) return { error: 'invalid-base-url' }
  if (raw.protocol !== 'openai' && raw.protocol !== 'anthropic') return { error: 'invalid-protocol' }
  if (!model || model.length > MAX_MODEL) return { error: 'invalid-model' }
  if (!apiKey || apiKey.length > MAX_KEY) return { error: 'invalid-api-key' }
  return { name, baseUrl, protocol: raw.protocol, model, apiKey }
}

export class AdsCopyModelStore {
  private readonly filePathOverride?: string
  private readonly backend: SecretBackend
  private resolvedPath: string | null = null

  constructor(options: { filePath?: string; backend?: SecretBackend } = {}) {
    this.filePathOverride = options.filePath
    this.backend = options.backend ?? electronBackend
  }

  /** Resolved lazily so module-level construction never races app.getPath. */
  private get filePath(): string {
    if (!this.resolvedPath) {
      this.resolvedPath = this.filePathOverride ?? path.join(app.getPath('userData'), 'ads-copy-models.bin')
    }
    return this.resolvedPath
  }

  async load(): Promise<AdsCopyModelPool> {
    try {
      if (!this.backend.isAvailable()) return { providers: [], pool: [], mode: 'chat' }
      const encoded = await readFile(this.filePath, 'utf8')
      const raw = JSON.parse(this.backend.decrypt(Buffer.from(encoded, 'base64'))) as Record<string, unknown>
      const providers: AdsCopyModelProvider[] = Array.isArray(raw.providers)
        ? (raw.providers as Array<Record<string, unknown>>)
            .map((item) => this.validateProvider(item))
            .filter((item): item is AdsCopyModelProvider => item !== null)
        : []
      const known = new Set(providers.map((provider) => provider.id))
      const pool = Array.isArray(raw.pool)
        ? (raw.pool as unknown[]).filter((id): id is string => typeof id === 'string' && known.has(id))
        : []
      const mode = raw.mode === 'pool' ? 'pool' : 'chat'
      return { providers, pool, mode }
    } catch {
      return { providers: [], pool: [], mode: 'chat' }
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

  private async persist(pool: AdsCopyModelPool): Promise<void> {
    if (!this.backend.isAvailable()) {
      throw new Error('secure credential storage is unavailable on this device')
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const encrypted = this.backend.encrypt(JSON.stringify(pool))
    await writeFile(this.filePath, encrypted.toString('base64'), { mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }

  async upsert(input: AdsCopyModelInput, id?: string): Promise<AdsCopyModelPool> {
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
          provider.id === id ? { ...provider, ...input, id, createdAt: existing.createdAt } : provider
        ),
        pool: current.pool,
        mode: current.mode
      }
      await this.persist(next)
      return next
    }
    const provider: AdsCopyModelProvider = { id: crypto.randomUUID(), ...input, createdAt: now }
    const next: AdsCopyModelPool = { providers: [...current.providers, provider], pool: current.pool, mode: current.mode }
    await this.persist(next)
    return next
  }

  async remove(id: string): Promise<AdsCopyModelPool> {
    const current = await this.load()
    const next: AdsCopyModelPool = {
      providers: current.providers.filter((provider) => provider.id !== id),
      pool: current.pool.filter((poolId) => poolId !== id),
      mode: current.mode
    }
    await this.persist(next)
    return next
  }

  async setPool(poolIds: string[]): Promise<AdsCopyModelPool> {
    const current = await this.load()
    const known = new Set(current.providers.map((provider) => provider.id))
    const deduped: string[] = []
    for (const id of poolIds) {
      if (typeof id === 'string' && known.has(id) && !deduped.includes(id)) deduped.push(id)
    }
    const next: AdsCopyModelPool = { providers: current.providers, pool: deduped, mode: current.mode }
    await this.persist(next)
    return next
  }

  async setMode(mode: 'chat' | 'pool'): Promise<AdsCopyModelPool> {
    const current = await this.load()
    const next: AdsCopyModelPool = { ...current, mode: mode === 'pool' ? 'pool' : 'chat' }
    await this.persist(next)
    return next
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath)
    } catch {
      // Absent file is already empty.
    }
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
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      model: provider.model,
      inPool: poolSet.has(provider.id),
      createdAt: provider.createdAt
    }))
  }
}
