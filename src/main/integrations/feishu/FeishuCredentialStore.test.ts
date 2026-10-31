import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeishuCredentialStore, SecretBackend } from './FeishuCredentialStore'

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
