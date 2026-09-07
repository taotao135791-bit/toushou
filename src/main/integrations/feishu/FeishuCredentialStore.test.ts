import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
