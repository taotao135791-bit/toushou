import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { LarkBrand } from '../../../shared/connections'
import { SecureStorageCoordinator, secureStorageCoordinator } from '../secureStorageCoordinator'

export interface FeishuStoredCredentials {
  appId: string
  appSecret: string
  brand: LarkBrand
  ownerOpenId?: string
  tenantBrand?: LarkBrand
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  refreshExpiresAt?: number
  scope?: string
  savedAt: number
}

export interface SecretBackend {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

const electronBackend: SecretBackend = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value)
}

export const FEISHU_CREDENTIAL_UNAVAILABLE = '已保存的飞书凭据暂时无法读取，原数据已保留。请检查系统安全存储后点击重试。'
export type FeishuCredentialLoadResult =
  | { status: 'absent' }
  | { status: 'unavailable' }
  | { status: 'ready'; credentials: FeishuStoredCredentials }

/**
 * Main-only credential storage. The file is just an encrypted envelope; the
 * plaintext app secret, OAuth tokens, and owner identity never enter
 * electron-store or the renderer process.
 */
export class FeishuCredentialStore {
  private readonly filePath: string
  private readonly backend: SecretBackend
  private readonly coordinator: SecureStorageCoordinator
  private failed = false
  private failedOnEmptyStore = false
  private inFlight: Promise<FeishuCredentialLoadResult> | null = null
  private cached: { encoded: string; credentials: FeishuStoredCredentials } | null = null

  constructor(options: { filePath?: string; backend?: SecretBackend; coordinator?: SecureStorageCoordinator } = {}) {
    this.filePath = options.filePath ?? path.join(app.getPath('userData'), 'feishu-credentials.bin')
    this.backend = options.backend ?? electronBackend
    this.coordinator = options.coordinator ?? (options.backend ? new SecureStorageCoordinator() : secureStorageCoordinator)
  }

  async save(credentials: Omit<FeishuStoredCredentials, 'savedAt'>, options: { retryEpoch?: number | null } = {}): Promise<void> {
    // Never replace an existing envelope that we cannot read. In particular,
    // a failed automatic restore is not the same as a fresh profile.
    const current = await this.loadResult()
    if (current.status === 'unavailable') throw new Error(FEISHU_CREDENTIAL_UNAVAILABLE)
    const payload: FeishuStoredCredentials = { ...credentials, savedAt: Date.now() }
    let encrypted: Buffer
    try {
      encrypted = this.coordinator.encrypt(this.backend, JSON.stringify(payload), { retry: options.retryEpoch != null && current.status === 'absent', retryEpoch: options.retryEpoch })
    } catch {
      this.failed = true
      this.failedOnEmptyStore = current.status === 'absent'
      this.cached = null
      throw new Error(current.status === 'ready' ? FEISHU_CREDENTIAL_UNAVAILABLE : '系统安全存储暂不可用，未保存飞书凭据。请检查系统安全存储后点击重试。')
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(tempPath, encrypted.toString('base64'), { mode: 0o600, flag: 'wx' })
      await rename(tempPath, this.filePath)
    } finally {
      await unlink(tempPath).catch(() => undefined)
    }
    this.cached = { encoded: encrypted.toString('base64'), credentials: payload }
  }

  async load(): Promise<FeishuStoredCredentials | null> {
    const result = await this.loadResult()
    return result.status === 'ready' ? result.credentials : null
  }

  /** Failed decryptions stay paused until an explicit user retry. */
  blockedEpoch(): number | null { return this.coordinator.blockedEpoch() }

  async retryLoad(retryEpoch = this.coordinator.blockedEpoch()): Promise<FeishuCredentialLoadResult> {
    if (this.inFlight) await this.inFlight
    this.failed = false
    this.failedOnEmptyStore = false
    this.inFlight = this.readResult(true, retryEpoch).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  async loadResult(): Promise<FeishuCredentialLoadResult> {
    if (this.failed) return { status: 'unavailable' }
    if (!this.inFlight) {
      this.inFlight = this.readResult().finally(() => { this.inFlight = null })
    }
    return this.inFlight
  }

  /** A new connection can recheck an earlier failed first save without
   * retrying an unreadable existing envelope or touching native storage. */
  async loadForNewConnection(): Promise<FeishuCredentialLoadResult> {
    if (this.failedOnEmptyStore) {
      this.failed = false
      this.failedOnEmptyStore = false
    }
    return this.loadResult()
  }

  private async readResult(retry = false, retryEpoch: number | null = null): Promise<FeishuCredentialLoadResult> {
    let encoded: string
    try {
      // A fresh profile has no envelope: avoid consulting Keychain at all.
      // Only an existing file needs the secure-storage backend.
      encoded = await readFile(this.filePath, 'utf8')
    } catch (error) {
      this.cached = null
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'absent' }
      this.failed = true
      return { status: 'unavailable' }
    }
    try {
      if (!retry && this.cached?.encoded === encoded) return { status: 'ready', credentials: this.cached.credentials }
      const decoded = this.coordinator.decrypt(this.backend, Buffer.from(encoded, 'base64'), { retry, retryEpoch })
      const raw = JSON.parse(decoded) as Record<string, unknown>
      if (
        typeof raw.appId !== 'string' ||
        !raw.appId ||
        typeof raw.appSecret !== 'string' ||
        !raw.appSecret ||
        (raw.brand !== 'feishu' && raw.brand !== 'lark')
      ) {
        throw new Error('invalid credential envelope')
      }
      const credentials: FeishuStoredCredentials = {
        appId: raw.appId,
        appSecret: raw.appSecret,
        brand: raw.brand,
        ownerOpenId: typeof raw.ownerOpenId === 'string' ? raw.ownerOpenId : undefined,
        tenantBrand: raw.tenantBrand === 'feishu' || raw.tenantBrand === 'lark' ? raw.tenantBrand : undefined,
        accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : undefined,
        refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
        expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : undefined,
        refreshExpiresAt: typeof raw.refreshExpiresAt === 'number' ? raw.refreshExpiresAt : undefined,
        scope: typeof raw.scope === 'string' ? raw.scope : undefined,
        savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0
      }
      this.cached = { encoded, credentials }
      return { status: 'ready', credentials }
    } catch {
      this.cached = null
      this.failed = true
      return { status: 'unavailable' }
    }
  }

  /** True when a stored envelope exists — distinguishes "never connected"
   * from "stored credentials could not be decrypted". */
  async exists(): Promise<boolean> {
    try {
      await readFile(this.filePath, 'utf8')
      return true
    } catch {
      return false
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath)
    } catch {
      // Already absent is the desired outcome.
    }
    this.failed = false
    this.failedOnEmptyStore = false
    this.cached = null
  }

  /** Test-only visibility: proves the persisted envelope is not plaintext. */
  async readRawForTest(): Promise<Buffer> {
    return readFile(this.filePath)
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 6) return '••••••'
  return `${value.slice(0, 3)}••••${value.slice(-3)}`
}
