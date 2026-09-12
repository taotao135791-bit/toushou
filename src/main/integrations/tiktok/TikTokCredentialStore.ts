import { app, safeStorage } from 'electron'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SecretBackend } from '../feishu/FeishuCredentialStore'

export interface TikTokStoredCredentials {
  /** Dynamic-client-registration client id (RFC 7591). */
  clientId: string
  /** Issued by some authorization servers alongside the id; sent when present. */
  clientSecret?: string
  /** Discovered token endpoint, persisted so refreshes never re-discover. */
  tokenEndpoint?: string
  accessToken?: string
  refreshToken?: string
  /** Epoch ms when the access token expires. */
  expiresAt?: number
  scope?: string
  savedAt: number
}

const electronBackend: SecretBackend = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value)
}

/**
 * Main-only credential storage for the TikTok Ads MCP connection — the same
 * encrypted-envelope pattern as the Feishu store: the plaintext client secret
 * and OAuth tokens never enter electron-store or the renderer process.
 */
export class TikTokCredentialStore {
  private readonly filePath: string
  private readonly backend: SecretBackend

  constructor(options: { filePath?: string; backend?: SecretBackend } = {}) {
    this.filePath = options.filePath ?? path.join(app.getPath('userData'), 'tiktok-ads-credentials.bin')
    this.backend = options.backend ?? electronBackend
  }

  async save(credentials: Omit<TikTokStoredCredentials, 'savedAt'>): Promise<void> {
    if (!this.backend.isAvailable()) {
      throw new Error('secure credential storage is unavailable on this device')
    }
    const payload: TikTokStoredCredentials = { ...credentials, savedAt: Date.now() }
    const encrypted = this.backend.encrypt(JSON.stringify(payload))
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, encrypted.toString('base64'), { mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }

  async load(): Promise<TikTokStoredCredentials | null> {
    try {
      if (!this.backend.isAvailable()) return null
      const encoded = await readFile(this.filePath, 'utf8')
      const raw = JSON.parse(this.backend.decrypt(Buffer.from(encoded, 'base64'))) as Record<string, unknown>
      if (typeof raw.clientId !== 'string' || !raw.clientId) return null
      return {
        clientId: raw.clientId,
        clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret : undefined,
        tokenEndpoint: typeof raw.tokenEndpoint === 'string' ? raw.tokenEndpoint : undefined,
        accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : undefined,
        refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
        expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : undefined,
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
}
