import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TikTokConnectionStore resolves its default file through electron's
// app.getPath; tests inject an explicit file, and beforeEach points
// userData at a fresh temp dir.
let userDataDir = ''
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))

import {
  clearTikTokCredentials,
  listTikTokCredentials,
  loadTikTokCredentials,
  maskTikTokSecret,
  mergeTikTokTokens,
  parseTikTokCredentialInput,
  setTikTokCredentials
} from './TikTokConnectionStore'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tiktok-creds-'))
  userDataDir = dir
  file = path.join(dir, 'tiktok-report-credentials.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseTikTokCredentialInput', () => {
  it('accepts a bounded paste-token payload', () => {
    const parsed = parseTikTokCredentialInput({ accessToken: 'a'.repeat(64) })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.credentials.accessToken).toBe('a'.repeat(64))
  })

  it('rejects oversized strings, bad advertiser ids and non-objects', () => {
    expect(parseTikTokCredentialInput({ accessToken: '' }).ok).toBe(true) // keep-existing shape
    expect(parseTikTokCredentialInput({ accessToken: 'x'.repeat(5000) }).ok).toBe(false)
    expect(parseTikTokCredentialInput({ accessToken: 'tok', appId: 'a\tb' }).ok).toBe(false)
    expect(parseTikTokCredentialInput({ accessToken: 'tok', appSecret: 's'.repeat(300) }).ok).toBe(false)
    expect(parseTikTokCredentialInput({ accessToken: 'tok', advertiserIds: ['abc'] }).ok).toBe(false)
    expect(parseTikTokCredentialInput({ accessToken: 'tok', advertiserIds: [0] }).ok).toBe(false)
    expect(parseTikTokCredentialInput({ accessToken: 'tok', advertiserIds: Array(51).fill(1) }).ok).toBe(false)
    expect(parseTikTokCredentialInput('nope').ok).toBe(false)
  })

  it('normalizes advertiser ids from numbers or numeric strings and dedupes', () => {
    const parsed = parseTikTokCredentialInput({
      accessToken: 'tok',
      advertiserIds: [' 7300001 ', 7300001, 42]
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.credentials.advertisers).toEqual([7300001, 42])
  })
})

describe('credentials round-trip + masking', () => {
  it('saves, loads and lists with only masked values', () => {
    const outcome = setTikTokCredentials(
      {
        appId: '7312345678901234567',
        appSecret: 'super-secret',
        accessToken: 'access-token-abcdef123456',
        refreshToken: 'refresh-token-abcdef123456',
        advertiserIds: [7300001]
      },
      file
    )
    expect(outcome.ok).toBe(true)

    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.accessToken).toBe('access-token-abcdef123456')
    expect(onDisk.advertisers).toEqual([7300001])

    const loaded = loadTikTokCredentials(file)
    expect(loaded?.appSecret).toBe('super-secret')

    const info = listTikTokCredentials(file)
    expect(info.configured).toBe(true)
    expect(info.mode).toBe('oauth')
    expect(info.tokenMasked).toBe('acc…456')
    expect(JSON.stringify(info)).not.toContain('super-secret')
    expect(JSON.stringify(info)).not.toContain('access-token-abcdef123456')
    expect(JSON.stringify(info)).not.toContain('refresh-token-abcdef123456')
  })

  it('writes the credentials file with mode 0600', () => {
    setTikTokCredentials({ accessToken: 'a'.repeat(32) }, file)
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('keeps the stored token when the update omits one, and stamps issue time on a fresh paste', () => {
    const before = Date.now()
    setTikTokCredentials({ accessToken: 'first-token-123456' }, file)
    const edited = setTikTokCredentials({ appId: '731', advertiserIds: [7300001] }, file)
    expect(edited.ok).toBe(true)
    const kept = loadTikTokCredentials(file)
    expect(kept?.accessToken).toBe('first-token-123456')
    expect(kept?.appId).toBe('731')

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      setTikTokCredentials({ accessToken: 'second-token-654321' }, file)
      const replaced = loadTikTokCredentials(file)
      expect(replaced?.accessToken).toBe('second-token-654321')
      expect(replaced?.appId).toBe('731') // unrelated fields survive
      expect(replaced?.issuedAt).toBe(Date.now())
    } finally {
      vi.useRealTimers()
    }
    expect(before).toBeLessThanOrEqual(Date.now())
  })

  it('refuses the very first save without any token', () => {
    const outcome = setTikTokCredentials({ appId: '731' }, file)
    expect(outcome).toEqual({ ok: false, error: 'missing-token' })
    expect(listTikTokCredentials(file).configured).toBe(false)
  })

  it('clear removes the record and lists unconfigured', () => {
    setTikTokCredentials({ accessToken: 'tok-123456789' }, file)
    clearTikTokCredentials(file)
    expect(listTikTokCredentials(file)).toEqual({
      configured: false,
      mode: 'none',
      tokenMasked: '',
      hasRefreshToken: false,
      advertiserIds: []
    })
  })

  it('mergeTikTokTokens rotates the access token and preserves advertisers', () => {
    setTikTokCredentials({ accessToken: 'old-token-123456', advertiserIds: [7300001] }, file)
    const merged = mergeTikTokTokens(
      { accessToken: 'new-token-654321', refreshToken: 'rt-1', expiresAt: 1893456000000 },
      file
    )
    expect(merged.accessToken).toBe('new-token-654321')
    expect(merged.advertisers).toEqual([7300001])
    const info = listTikTokCredentials(file)
    expect(info.tokenMasked).toBe('new…321')
    expect(info.expiresAt).toBe(1893456000000)
  })

  it('maskTikTokSecret hides short values entirely', () => {
    expect(maskTikTokSecret('short')).toBe('••••••••')
    expect(maskTikTokSecret('longenoughtoken')).toBe('lon…ken')
  })
})
