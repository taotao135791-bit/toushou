import { app, safeStorage } from 'electron'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LarkBrand } from '../../../shared/connections'

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

/**
 * Main-only credential storage. The file is just an encrypted envelope; the
 * plaintext app secret, OAuth tokens, and owner identity never enter
 * electron-store or the renderer process.
 */
export class FeishuCredentialStore {
  private readonly filePath: string
  private readonly backend: SecretBackend

  constructor(options: { filePath?: string; backend?: SecretBackend } = {}) {
    this.filePath = options.filePath ?? path.join(app.getPath('userData'), 'feishu-credentials.bin')
    this.backend = options.backend ?? electronBackend
  }

  async save(credentials: Omit<FeishuStoredCredentials, 'savedAt'>): Promise<void> {
    if (!this.backend.isAvailable()) {
      throw new Error('secure credential storage is unavailable on this device')
    }
    const payload: FeishuStoredCredentials = { ...credentials, savedAt: Date.now() }
    const encrypted = this.backend.encrypt(JSON.stringify(payload))
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, encrypted.toString('base64'), { mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }

  async load(): Promise<FeishuStoredCredentials | null> {
    try {
      if (!this.backend.isAvailable()) return null
      const encoded = await readFile(this.filePath, 'utf8')
      const raw = JSON.parse(this.backend.decrypt(Buffer.from(encoded, 'base64'))) as Record<string, unknown>
      if (
        typeof raw.appId !== 'string' ||
        !raw.appId ||
        typeof raw.appSecret !== 'string' ||
        !raw.appSecret ||
        (raw.brand !== 'feishu' && raw.brand !== 'lark')
      ) {
        return null
      }
      return {
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
    } catch {
      return null
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath)
    } catch {
      // Already absent is the desired outcome.
    }
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
