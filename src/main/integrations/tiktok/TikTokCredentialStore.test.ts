import { mkdtempSync, rmSync, writeFile } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promisify } from 'node:util'

// The store only touches electron for its default file/backend; tests inject
// both, but the module import still resolves electron — stub it.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-unused' }, safeStorage: { isEncryptionAvailable: () => true } }))

import { TikTokCredentialStore } from './TikTokCredentialStore'
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
  it('round-trips advertiser ids through the encrypted envelope', async () => {
    const file = path.join(dir, 'creds.bin')
    const store = new TikTokCredentialStore({ filePath: file, backend: passthroughBackend() })
    await store.save({
      clientId: 'client-1',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: 1234567890,
      scope: 'mcp:tt4b',
      advertiserIds: [7300001, 7300002]
    })
    const loaded = await store.load()
    expect(loaded).not.toBeNull()
    expect(loaded?.clientId).toBe('client-1')
    expect(loaded?.accessToken).toBe('at-1')
    expect(loaded?.advertiserIds).toEqual([7300001, 7300002])
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
        advertiserIds: [7300001, 'junk', -5, 0, 1.5, '7300002', 7300001]
      })
    ).toString('base64')
    await writeFileP(file, Buffer.from(envelope, 'utf8'))
    const store = new TikTokCredentialStore({ filePath: file, backend: passthroughBackend() })
    const loaded = await store.load()
    // Only positive integer ids survive, de-duplicated; the numeric-string
    // form is coerced (same tolerance as the report client's parser).
    expect(loaded?.advertiserIds).toEqual([7300001, 7300002])
  })
})
