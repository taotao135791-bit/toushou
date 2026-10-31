import { mkdtempSync, readFileSync, rmSync, writeFile } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promisify } from 'node:util'

// The store only touches electron for its default file/backend; tests inject
// both, but the module import still resolves electron — stub it.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-unused' }, safeStorage: { isEncryptionAvailable: () => true } }))

import { TikTokCredentialStore } from './TikTokCredentialStore'
import { TikTokCredentialStorageError } from './tiktokCredentialStorageError'
import { FeishuCredentialStore } from '../feishu/FeishuCredentialStore'
import { SecureStorageCoordinator } from '../secureStorageCoordinator'
import type { SecretBackend } from '../feishu/FeishuCredentialStore'

/** Identity backend so tests can also write plaintext envelopes directly. */
function passthroughBackend(): SecretBackend {
  return {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(value, 'utf8'),
    decrypt: (value: Buffer) => value.toString('utf8')
  }
}

let dir: string
const writeFileP = promisify(writeFile)

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tiktok-credstore-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('TikTokCredentialStore advertiserIds persistence', () => {
  it('does not touch secure storage when no credential file exists', async () => {
    const isAvailable = vi.fn(() => { throw Error('Keychain must not be touched') })
    const backend = { isAvailable, encrypt: vi.fn(), decrypt: vi.fn() } as unknown as SecretBackend
    await expect(new TikTokCredentialStore({ filePath: path.join(dir, 'missing.bin'), backend }).load()).resolves.toBeNull()
    expect(isAvailable).not.toHaveBeenCalled()
    expect(backend.decrypt).not.toHaveBeenCalled()
  })
  it('does not accept an existing envelope when secure storage is unavailable', async () => {
    const file = path.join(dir, 'corrupt.bin')
    await writeFileP(file, 'invalid')
    const isAvailable = vi.fn(() => false)
    const backend = { isAvailable, encrypt: vi.fn(), decrypt: vi.fn() } as unknown as SecretBackend
    const store = new TikTokCredentialStore({ filePath: file, backend })
    await expect(store.load()).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    await expect(store.load()).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    await expect(store.save({ clientId: 'new' })).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(readFileSync(file, 'utf8')).toBe('invalid')
    expect(isAvailable).toHaveBeenCalledOnce()
    expect(backend.decrypt).not.toHaveBeenCalled()
  })
  it('leaves a corrupt encrypted envelope untouched', async () => {
    const file = path.join(dir, 'corrupt.bin')
    await writeFileP(file, 'invalid')
    const backend = { isAvailable: () => true, encrypt: vi.fn(), decrypt: vi.fn(() => { throw Error('corrupt') }) } as unknown as SecretBackend
    await expect(new TikTokCredentialStore({ filePath: file, backend }).load()).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(readFileSync(file, 'utf8')).toBe('invalid')
  })
  it('coalesces concurrent failed loads, preserves old bytes and retries only explicitly', async () => {
    const file = path.join(dir, 'creds.bin')
    const bytes = Buffer.from(JSON.stringify({ clientId: 'old' })).toString('base64')
    await writeFileP(file, bytes)
    let available = false
    const isAvailable = vi.fn(() => available)
    const backend = { ...passthroughBackend(), isAvailable }
    const store = new TikTokCredentialStore({ filePath: file, backend })
    const first = await Promise.allSettled([store.load(), store.load(), store.load()])
    expect(first.every((result) => result.status === 'rejected')).toBe(true)
    expect(isAvailable).toHaveBeenCalledTimes(1)
    await expect(store.save({ clientId: 'new' })).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    available = true
    expect((await store.retry())?.clientId).toBe('old')
    expect(isAvailable).toHaveBeenCalledTimes(2)
    await store.save({ clientId: 'new' })
    expect((await store.load())?.clientId).toBe('new')
  })

  it('does not overwrite an existing undecipherable envelope even without a prior load', async () => {
    const file = path.join(dir, 'creds.bin')
    await writeFileP(file, 'old ciphertext')
    const store = new TikTokCredentialStore({ filePath: file, backend: { ...passthroughBackend(), decrypt: () => { throw new Error('locked') } } })
    await expect(store.save({ clientId: 'new' })).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(readFileSync(file, 'utf8')).toBe('old ciphertext')
  })

  it('will not overwrite an envelope created after an absent-file read', async () => {
    const file = path.join(dir, 'creds.bin')
    const backend = { ...passthroughBackend(), decrypt: () => { throw new Error('locked') } }
    const store = new TikTokCredentialStore({ filePath: file, backend })
    expect(await store.load()).toBeNull()
    await writeFileP(file, 'newly created ciphertext')
    await expect(store.save({ clientId: 'new' })).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(readFileSync(file, 'utf8')).toBe('newly created ciphertext')
  })

  it('shares a native failure latch with Feishu and only explicit retry reopens Keychain', async () => {
    const ttFile = path.join(dir, 'tiktok.bin'), feishuFile = path.join(dir, 'feishu.bin')
    await writeFileP(ttFile, Buffer.from(JSON.stringify({ clientId: 'fake' })).toString('base64'))
    await writeFileP(feishuFile, Buffer.from(JSON.stringify({ appId: 'fake', appSecret: 'fake', brand: 'feishu' })).toString('base64'))
    const coordinator = new SecureStorageCoordinator()
    const backend = { ...passthroughBackend(), decrypt: vi.fn((value: Buffer) => value.toString('utf8')) }
    backend.decrypt.mockImplementationOnce(() => { throw new Error('native locked') })
    const tt = new TikTokCredentialStore({ filePath: ttFile, backend, coordinator })
    const feishu = new FeishuCredentialStore({ filePath: feishuFile, backend, coordinator })
    await expect(tt.load()).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect((await feishu.loadResult()).status).toBe('unavailable')
    expect(backend.decrypt).toHaveBeenCalledTimes(1)
    expect((await tt.retry())?.clientId).toBe('fake')
    expect(backend.decrypt).toHaveBeenCalledTimes(2)
    expect((await feishu.retryLoad()).status).toBe('ready')
  })

  it('allows one native retry for a completed first authorization on an empty profile', async () => {
    const coordinator = new SecureStorageCoordinator()
    const backend = { ...passthroughBackend(), isAvailable: vi.fn(() => true), encrypt: vi.fn((value: string) => Buffer.from(value)) }
    expect(() => coordinator.decrypt({ ...backend, decrypt: () => { throw new Error('locked') } }, Buffer.from('other'))).toThrow()
    const store = new TikTokCredentialStore({ filePath: path.join(dir, 'new.bin'), backend, coordinator })
    await store.save({ clientId: 'new' }, { retryNewAuthorizationEpoch: coordinator.blockedEpoch() })
    expect(backend.encrypt).toHaveBeenCalledTimes(1)
    expect(coordinator.isBlocked()).toBe(false)
    expect((await store.load())?.clientId).toBe('new')
  })

  it('never bypasses a shared failure for a verified existing envelope or background save', async () => {
    const coordinator = new SecureStorageCoordinator()
    const backend = { ...passthroughBackend(), encrypt: vi.fn((value: string) => Buffer.from(value)) }
    const file = path.join(dir, 'existing.bin')
    const store = new TikTokCredentialStore({ filePath: file, backend, coordinator })
    await store.save({ clientId: 'old' })
    const old = readFileSync(file, 'utf8')
    backend.encrypt.mockClear()
    expect(() => coordinator.decrypt({ ...backend, decrypt: () => { throw new Error('locked') } }, Buffer.from('other'))).toThrow()
    await expect(store.save({ clientId: 'new' }, { retryNewAuthorizationEpoch: coordinator.blockedEpoch() })).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(backend.encrypt).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(old)
    const newStore = new TikTokCredentialStore({ filePath: path.join(dir, 'background.bin'), backend, coordinator })
    await expect(newStore.save({ clientId: 'new' })).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(backend.encrypt).not.toHaveBeenCalled()
  })

  it('does not use an old user retry to bypass a newer shared failure while reading old credentials', async () => {
    const file = path.join(dir, 'old.bin')
    const bytes = Buffer.from(JSON.stringify({ clientId: 'old' })).toString('base64')
    await writeFileP(file, bytes)
    const coordinator = new SecureStorageCoordinator()
    const backend = { ...passthroughBackend(), decrypt: vi.fn((value: Buffer) => value.toString('utf8')) }
    backend.decrypt.mockImplementationOnce(() => { throw new Error('first') })
    const store = new TikTokCredentialStore({ filePath: file, backend, coordinator })
    await expect(store.load()).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    const initialEpoch = coordinator.blockedEpoch()
    coordinator.decrypt(backend, Buffer.from('unlocked'), { retry: true, retryEpoch: initialEpoch })
    expect(() => coordinator.decrypt({ ...backend, decrypt: () => { throw new Error('second') } }, Buffer.from('x'))).toThrow()
    const calls = backend.decrypt.mock.calls.length
    await expect(store.retry(initialEpoch)).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(backend.decrypt).toHaveBeenCalledTimes(calls)
    expect(readFileSync(file, 'utf8')).toBe(bytes)
  })

  it('does not block other stores when decrypted TikTok JSON is malformed', async () => {
    const file = path.join(dir, 'invalid.bin')
    await writeFileP(file, Buffer.from('not-json').toString('base64'))
    const coordinator = new SecureStorageCoordinator()
    const backend = passthroughBackend()
    await expect(new TikTokCredentialStore({ filePath: file, backend, coordinator }).load()).rejects.toBeInstanceOf(TikTokCredentialStorageError)
    expect(coordinator.isBlocked()).toBe(false)
    expect(coordinator.decrypt(backend, Buffer.from('other'))).toBe('other')
  })

  it('round-trips advertiser ids through the encrypted envelope', async () => {
    const file = path.join(dir, 'creds.bin')
    const store = new TikTokCredentialStore({ filePath: file, backend: passthroughBackend() })
    await store.save({
      clientId: 'client-1',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: 1234567890,
      scope: 'mcp:tt4b',
      advertiserIds: ['7300000000000000001', '7300002']
    })
    const loaded = await store.load()
    expect(loaded).not.toBeNull()
    expect(loaded?.clientId).toBe('client-1')
    expect(loaded?.accessToken).toBe('at-1')
    expect(loaded?.advertiserIds).toEqual(['7300000000000000001', '7300002'])
  })

  it('tolerates a stored record without advertiser ids (older envelopes)', async () => {
    const file = path.join(dir, 'creds.bin')
    const store = new TikTokCredentialStore({ filePath: file, backend: passthroughBackend() })
    await store.save({ clientId: 'client-1', accessToken: 'at-1', refreshToken: 'rt-1' })
    const loaded = await store.load()
    expect(loaded?.advertiserIds).toBeUndefined()
  })

  it('drops corrupt advertiser entries instead of failing the load', async () => {
    const file = path.join(dir, 'creds.bin')
    // save() stores base64(utf8(json)) — mirror that exact envelope so the
    // load path decodes a hand-written payload with junk ids.
    const envelope = Buffer.from(
      JSON.stringify({
        clientId: 'client-1',
        accessToken: 'at-1',
        advertiserIds: [7300001, 'junk', -5, 0, 1.5, '7300002', 7300001, Number('7300000000000000001'), '7300000000000000003']
      })
    ).toString('base64')
    await writeFileP(file, Buffer.from(envelope, 'utf8'))
    const store = new TikTokCredentialStore({ filePath: file, backend: passthroughBackend() })
    const loaded = await store.load()
    // Only positive integer ids survive, de-duplicated, as decimal strings.
    // A number past MAX_SAFE_INTEGER has already lost digits and is dropped.
    expect(loaded?.advertiserIds).toEqual(['7300001', '7300002', '7300000000000000003'])
  })
})
