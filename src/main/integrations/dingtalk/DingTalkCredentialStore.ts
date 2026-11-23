import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DingTalkCredentials } from '../../../shared/connections'
import { secureStorageCoordinator, type SecureStorageAttempt, type SecureStorageBackend } from '../secureStorageCoordinator'

export interface DingTalkConfiguration extends DingTalkCredentials {
  owner?: { senderId: string; conversationId: string }
}

export function parseDingTalkCredentials(raw: unknown): DingTalkCredentials | null {
  if (!raw || typeof raw !== 'object') return null
  const { clientId, clientSecret } = raw as Partial<DingTalkCredentials>
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return null
  const cleanId = clientId.trim()
  const cleanSecret = clientSecret.trim()
  const credential = /^[!-~]{1,512}$/
  return credential.test(cleanId) && credential.test(cleanSecret)
    ? { clientId: cleanId, clientSecret: cleanSecret }
    : null
}

const backend: SecureStorageBackend = {
  isAvailable: () => safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: value => safeStorage.encryptString(value),
  decrypt: value => safeStorage.decryptString(value)
}

export class DingTalkCredentialStore {
  constructor(private readonly file = path.join(app.getPath('userData'), 'dingtalk-credentials.bin')) {}

  async load(attempt?: SecureStorageAttempt): Promise<DingTalkConfiguration | null> {
    const envelope = await readFile(this.file).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!envelope) return null
    if (envelope.length > 16_384) throw new Error('invalid DingTalk credential envelope')
    const parsed = JSON.parse(secureStorageCoordinator.decrypt(backend, envelope, attempt)) as Partial<DingTalkConfiguration> | null
    const credentials = parseDingTalkCredentials(parsed)
    const owner = parsed?.owner
    const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
    if (!credentials || (owner !== undefined && (!validId(owner?.senderId) || !validId(owner?.conversationId)))) {
      throw new Error('invalid DingTalk credentials')
    }
    return { ...credentials, ...(owner ? { owner: { senderId: owner.senderId, conversationId: owner.conversationId } } : {}) }
  }

  async save(configuration: DingTalkConfiguration, attempt?: SecureStorageAttempt, canCommit: () => boolean = () => true): Promise<boolean> {
    if (!canCommit()) return false
    const envelope = secureStorageCoordinator.encrypt(backend, JSON.stringify(configuration), attempt)
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await mkdir(path.dirname(this.file), { recursive: true })
    let committed = false
    try {
      await writeFile(temporary, envelope, { flag: 'wx', mode: 0o600 })
      if (!canCommit()) return false
      // Publish the credential in the same turn as the lifecycle check.
      renameSync(temporary, this.file)
      committed = true
      return true
    } finally {
      if (!committed) await unlink(temporary).catch(() => undefined)
    }
  }

  async clear(): Promise<void> {
    await unlink(this.file).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
