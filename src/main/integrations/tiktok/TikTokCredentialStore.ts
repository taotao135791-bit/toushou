import { app, safeStorage } from 'electron'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { TikTokCredentialStorageError } from './tiktokCredentialStorageError'
import { SecureStorageCoordinator, secureStorageCoordinator } from '../secureStorageCoordinator'
import path from 'node:path'
import { normalizeTikTokAdvertiserIds } from '../../../shared/tiktokReport'
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
  /**
   * Advertiser ids the authorization granted (the token endpoint echoes them
   * back). Optional: some authorization servers omit the claim, and the
   * user lists the advertisers on the Connections page instead.
   */
  advertiserIds?: string[]
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
  private readonly coordinator: SecureStorageCoordinator
  private retryNativePending = false
  private retryEpochPending: number | null = null
  private failure: TikTokCredentialStorageError | null = null
  private pendingLoad: Promise<TikTokStoredCredentials | null> | null = null
  private verified = false
  private verifiedEnvelope: string | null = null

  constructor(options: { filePath?: string; backend?: SecretBackend; coordinator?: SecureStorageCoordinator } = {}) {
    this.filePath = options.filePath ?? path.join(app.getPath('userData'), 'tiktok-ads-credentials.bin')
    this.backend = options.backend ?? electronBackend
    this.coordinator = options.coordinator ?? (options.backend ? new SecureStorageCoordinator() : secureStorageCoordinator)
  }

  /** Snapshot the shared failure at the start of an explicit user action. */
  sharedStorageBlockedEpoch(): number | null { return this.coordinator.blockedEpoch() }

  /** Explicit user retry is the only operation that clears a storage failure. */
  async retry(retryEpoch: number | null = this.coordinator.blockedEpoch()): Promise<TikTokStoredCredentials | null> {
    this.failure = null
    this.retryNativePending = true
    this.retryEpochPending = retryEpoch
    return this.load()
  }

  async save(credentials: Omit<TikTokStoredCredentials, 'savedAt'>, options: { retryNewAuthorizationEpoch?: number | null } = {}): Promise<void> {
    if (this.failure) throw this.failure
    // Never replace an existing envelope until it has been decrypted successfully.
    if (!this.verified) await this.load()
    if (this.failure) throw this.failure
    // Another process may have created or replaced the file after our read.
    let current: string | null
    try { current = await readFile(this.filePath, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.failure = new TikTokCredentialStorageError(); throw this.failure }
      current = null
    }
    if (current !== this.verifiedEnvelope) { this.verified = false; await this.load() }
    let encrypted: Buffer
    try {
      // A completed user-initiated first OAuth grant may try the shared gate
      // once; an existing envelope must have been read successfully first.
      const retryEpoch = this.verifiedEnvelope === null ? options.retryNewAuthorizationEpoch : undefined
      this.retryNativePending = false
      this.retryEpochPending = null
      encrypted = this.coordinator.encrypt(this.backend, JSON.stringify({ ...credentials, savedAt: Date.now() }), { retry: retryEpoch != null, retryEpoch })
    } catch {
      this.failure = new TikTokCredentialStorageError()
      throw this.failure
    }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      await writeFile(temporary, encrypted.toString('base64'), { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.filePath)
      this.verified = true
      this.verifiedEnvelope = encrypted.toString('base64')
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  async load(): Promise<TikTokStoredCredentials | null> {
    if (this.failure) throw this.failure
    if (this.pendingLoad) return this.pendingLoad
    const pending = this.readCredentials()
    this.pendingLoad = pending
    try { return await pending } finally { if (this.pendingLoad === pending) this.pendingLoad = null }
  }

  private async readCredentials(): Promise<TikTokStoredCredentials | null> {
    let encoded: string
    try {
      encoded = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.verified = true; this.verifiedEnvelope = null; return null }
      this.failure = new TikTokCredentialStorageError()
      throw this.failure
    }
    try {
      const retry = this.retryNativePending
      const retryEpoch = this.retryEpochPending
      this.retryNativePending = false
      this.retryEpochPending = null
      const plaintext = this.coordinator.decrypt(this.backend, Buffer.from(encoded, 'base64'), { retry, retryEpoch })
      const raw = JSON.parse(plaintext) as Record<string, unknown>
      if (typeof raw.clientId !== 'string' || !raw.clientId) throw new Error('invalid envelope')
      this.verified = true
      this.verifiedEnvelope = encoded
      return {
        clientId: raw.clientId,
        clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret : undefined,
        tokenEndpoint: typeof raw.tokenEndpoint === 'string' ? raw.tokenEndpoint : undefined,
        accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : undefined,
        refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
        expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : undefined,
        scope: typeof raw.scope === 'string' ? raw.scope : undefined,
        ...(normalizeTikTokAdvertiserIds(raw.advertiserIds).length > 0
          ? { advertiserIds: normalizeTikTokAdvertiserIds(raw.advertiserIds) }
          : {}),
        savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0
      }
    } catch {
      this.failure = new TikTokCredentialStorageError()
      throw this.failure
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath)
      this.failure = null
      this.verified = false
      this.verifiedEnvelope = null
    } catch {
      // Already absent is the desired outcome.
    }
  }
}