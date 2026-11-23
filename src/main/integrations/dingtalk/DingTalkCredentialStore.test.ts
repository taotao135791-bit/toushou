import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { secureStorage } = vi.hoisted(() => ({
  secureStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'kwallet6',
    encryptString: vi.fn((value: string) => Buffer.from(value).reverse()),
    decryptString: vi.fn((value: Buffer) => Buffer.from(value).reverse().toString())
  }
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, safeStorage: secureStorage }))

import { DingTalkCredentialStore } from './DingTalkCredentialStore'

const configuration = {
  clientId: 'ding_synthetic',
  clientSecret: 'synthetic-test-secret',
  owner: { senderId: 'synthetic-user', conversationId: 'synthetic-conversation' }
}

let directory: string | undefined
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.clearAllMocks()
})

describe('DingTalk credential storage', () => {
  it('consults the OS vault only when there is a credential and round-trips the encrypted envelope', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'toushou-dingtalk-store-'))
    const file = path.join(directory, 'credentials.bin')
    const storage = new DingTalkCredentialStore(file)
    expect(await storage.load()).toBeNull()
    expect(secureStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(await storage.save(configuration)).toBe(true)
    expect(secureStorage.encryptString).toHaveBeenCalledWith(JSON.stringify(configuration))
    expect((await readFile(file)).includes(configuration.clientSecret)).toBe(false)
    expect(await new DingTalkCredentialStore(file).load()).toEqual(configuration)
    await storage.clear()
    expect(await new DingTalkCredentialStore(file).load()).toBeNull()
  })

  it('leaves the previous envelope intact when the connection changes during a write', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'toushou-dingtalk-store-'))
    const file = path.join(directory, 'credentials.bin')
    const storage = new DingTalkCredentialStore(file)
    await storage.save(configuration)
    const guard = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    expect(await storage.save({ ...configuration, clientId: 'different-app' }, undefined, guard)).toBe(false)
    expect(await storage.load()).toEqual(configuration)
    expect(await readdir(directory)).toEqual(['credentials.bin'])
  })
})
