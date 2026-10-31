import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeishuCredentialStore, SecretBackend } from './FeishuCredentialStore'
import { SecureStorageCoordinator } from '../secureStorageCoordinator'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const backend: SecretBackend = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
  decrypt: (value) => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString()
}

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('FeishuCredentialStore', () => {
  it('does not touch secure storage when no credential file exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const isAvailable = vi.fn(() => { throw Error('Keychain must not be touched') })
    const fake = { isAvailable, encrypt: vi.fn(), decrypt: vi.fn() } as unknown as SecretBackend
    await expect(new FeishuCredentialStore({ filePath: path.join(dir, 'missing.bin'), backend: fake }).load()).resolves.toBeNull()
    expect(isAvailable).not.toHaveBeenCalled()
    expect(fake.decrypt).not.toHaveBeenCalled()
  })
  it('does not treat an existing unreadable envelope as valid credentials', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'corrupt.bin')
    await writeFile(filePath, 'invalid')
    const isAvailable = vi.fn(() => false)
    const fake = { isAvailable, encrypt: vi.fn(), decrypt: vi.fn() } as unknown as SecretBackend
    const store = new FeishuCredentialStore({ filePath, backend: fake })
    await expect(store.load()).resolves.toBeNull()
    await expect(store.exists()).resolves.toBe(true)
    expect(isAvailable).toHaveBeenCalledOnce()
    expect(fake.decrypt).not.toHaveBeenCalled()
  })
  it('leaves a corrupt encrypted envelope untouched', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'corrupt.bin')
    await writeFile(filePath, 'invalid')
    const fake = { isAvailable: () => true, encrypt: vi.fn(), decrypt: vi.fn(() => { throw Error('corrupt') }) } as unknown as SecretBackend
    await expect(new FeishuCredentialStore({ filePath, backend: fake }).load()).resolves.toBeNull()
    expect(await readFile(filePath, 'utf8')).toBe('invalid')
  })
  it('does not confuse a backend ENOENT with an absent credential file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'credentials.bin')
    await writeFile(filePath, 'encrypted')
    const fake: SecretBackend = { isAvailable: () => { throw Object.assign(new Error('backend missing'), { code: 'ENOENT' }) }, encrypt: backend.encrypt, decrypt: backend.decrypt }
    const store = new FeishuCredentialStore({ filePath, backend: fake })
    expect(await store.loadResult()).toEqual({ status: 'unavailable' })
    await expect(store.save({ appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' })).rejects.toThrow('原数据已保留')
    expect(await readFile(filePath, 'utf8')).toBe('encrypted')
  })
  it('shares native failure blocking across stores and unlocks on an explicit retry', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const firstPath = path.join(dir, 'first.bin')
    const secondPath = path.join(dir, 'second.bin')
    const credentials = { appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' as const }
    await new FeishuCredentialStore({ filePath: firstPath, backend }).save(credentials)
    await new FeishuCredentialStore({ filePath: secondPath, backend }).save(credentials)
    const coordinator = new SecureStorageCoordinator()
    const firstBackend: SecretBackend = { ...backend, decrypt: vi.fn(() => { throw Error('native failure') }) }
    const secondBackend: SecretBackend = { ...backend, isAvailable: vi.fn(backend.isAvailable), decrypt: vi.fn(backend.decrypt) }
    const first = new FeishuCredentialStore({ filePath: firstPath, backend: firstBackend, coordinator })
    const second = new FeishuCredentialStore({ filePath: secondPath, backend: secondBackend, coordinator })
    expect(await first.loadResult()).toEqual({ status: 'unavailable' })
    expect(await second.loadResult()).toEqual({ status: 'unavailable' })
    expect(secondBackend.isAvailable).not.toHaveBeenCalled()
    expect(secondBackend.decrypt).not.toHaveBeenCalled()
    expect(await second.retryLoad()).toMatchObject({ status: 'ready', credentials })
    expect(coordinator.isBlocked()).toBe(false)
    expect(secondBackend.decrypt).toHaveBeenCalledTimes(1)
  })
  it('allows a user-initiated first save to retry a shared lock, but never a background save', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'missing.bin')
    const coordinator = new SecureStorageCoordinator()
    const other: SecretBackend = { ...backend, isAvailable: () => false }
    expect(() => coordinator.encrypt(other, 'fixture')).toThrow()
    const retryEpoch = coordinator.blockedEpoch()
    const fake: SecretBackend = { ...backend, isAvailable: vi.fn(backend.isAvailable), encrypt: vi.fn(backend.encrypt) }
    const store = new FeishuCredentialStore({ filePath, backend: fake, coordinator })
    const credentials = { appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' as const }
    await expect(store.save(credentials)).rejects.toThrow('安全存储暂不可用')
    expect(fake.isAvailable).not.toHaveBeenCalled()
    expect(await store.loadForNewConnection()).toEqual({ status: 'absent' })
    await store.save(credentials, { retryEpoch })
    expect(fake.isAvailable).toHaveBeenCalledOnce()
    expect(coordinator.isBlocked()).toBe(false)
    expect(await store.load()).toMatchObject(credentials)
  })
  it('does not use the new-connection retry to overwrite unreadable existing credentials', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'existing.bin')
    await writeFile(filePath, 'old-envelope')
    const coordinator = new SecureStorageCoordinator()
    expect(() => coordinator.encrypt({ ...backend, isAvailable: () => false }, 'fixture')).toThrow()
    const retryEpoch = coordinator.blockedEpoch()
    const fake: SecretBackend = { ...backend, isAvailable: vi.fn(backend.isAvailable), encrypt: vi.fn(backend.encrypt) }
    const store = new FeishuCredentialStore({ filePath, backend: fake, coordinator })
    expect(await store.loadForNewConnection()).toEqual({ status: 'unavailable' })
    await expect(store.save({ appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' }, { retryEpoch })).rejects.toThrow('原数据已保留')
    expect(fake.isAvailable).not.toHaveBeenCalled()
    expect(fake.encrypt).not.toHaveBeenCalled()
    expect(await readFile(filePath, 'utf8')).toBe('old-envelope')
  })
  it('keeps JSON validation failures local to the affected store', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'credentials.bin')
    await writeFile(filePath, Buffer.from('invalid').toString('base64'))
    const coordinator = new SecureStorageCoordinator()
    const fake: SecretBackend = { isAvailable: () => true, encrypt: backend.encrypt, decrypt: () => 'not-json' }
    expect(await new FeishuCredentialStore({ filePath, backend: fake, coordinator }).loadResult()).toEqual({ status: 'unavailable' })
    expect(coordinator.isBlocked()).toBe(false)
  })
  it('pauses repeated reads, refuses replacement and retries only on request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'credentials.bin')
    const credentials = { appId: 'cli_test', appSecret: 'super-secret', brand: 'feishu' as const }
    await new FeishuCredentialStore({ filePath, backend }).save(credentials)
    const original = await readFile(filePath, 'utf8')
    let available = false
    const fake: SecretBackend = { isAvailable: vi.fn(() => available), encrypt: vi.fn(backend.encrypt), decrypt: vi.fn(backend.decrypt) }
    const store = new FeishuCredentialStore({ filePath, backend: fake })
    expect(await store.loadResult()).toEqual({ status: 'unavailable' })
    expect(await store.load()).toBeNull()
    await expect(store.save({ ...credentials, appSecret: 'different-secret' })).rejects.toThrow('原数据已保留')
    expect(fake.isAvailable).toHaveBeenCalledTimes(1)
    expect(fake.encrypt).not.toHaveBeenCalled()
    expect(await readFile(filePath, 'utf8')).toBe(original)
    available = true
    expect(await store.retryLoad()).toMatchObject({ status: 'ready', credentials })
    expect(fake.isAvailable).toHaveBeenCalledTimes(2)
    await store.load()
    expect(fake.decrypt).toHaveBeenCalledTimes(1)
  })
  it.each(['unavailable', 'encryption-fails'] as const)('pauses repeated saves when secure storage becomes %s', async (failure) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'credentials.bin')
    const credentials = { appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' as const }
    let broken = false
    const fake: SecretBackend = {
      isAvailable: vi.fn(() => !(broken && failure === 'unavailable')),
      encrypt: vi.fn(value => { if (broken && failure === 'encryption-fails') throw new Error('backend failed'); return backend.encrypt(value) }),
      decrypt: vi.fn(backend.decrypt)
    }
    const store = new FeishuCredentialStore({ filePath, backend: fake })
    await store.save(credentials)
    const original = await readFile(filePath, 'utf8')
    broken = true
    await expect(store.save({ ...credentials, appSecret: 'replacement' })).rejects.toThrow('原数据已保留')
    const calls = vi.mocked(fake.isAvailable).mock.calls.length
    await expect(store.save(credentials)).rejects.toThrow('原数据已保留')
    expect(fake.isAvailable).toHaveBeenCalledTimes(calls)
    expect(await readFile(filePath, 'utf8')).toBe(original)
    broken = false
    expect(await store.retryLoad()).toMatchObject({ status: 'ready', credentials })
  })
  it('keeps the prior envelope and removes the temporary file when atomic replacement fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'credentials.bin')
    const store = new FeishuCredentialStore({ filePath, backend })
    const credentials = { appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' as const }
    await store.save(credentials)
    const original = await readFile(filePath, 'utf8')
    if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    vi.mocked(rename).mockRejectedValueOnce(new Error('rename failed'))
    await expect(store.save({ ...credentials, appSecret: 'replacement' })).rejects.toThrow('rename failed')
    expect(await readFile(filePath, 'utf8')).toBe(original)
    expect(await readdir(dir)).toEqual(['credentials.bin'])
  })
  it('persists credentials in an encrypted Main-owned file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'credentials.bin')
    const store = new FeishuCredentialStore({ filePath, backend })
    await store.save({ appId: 'cli_test', appSecret: 'super-secret', brand: 'feishu', ownerOpenId: 'ou_owner' })
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('super-secret')
    await expect(store.load()).resolves.toMatchObject({ appId: 'cli_test', appSecret: 'super-secret', ownerOpenId: 'ou_owner' })
    await store.clear()
    await expect(store.load()).resolves.toBeNull()
  })
})
