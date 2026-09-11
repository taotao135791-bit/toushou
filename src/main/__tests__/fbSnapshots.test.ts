import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// fbSnapshots.ts only touches app.getPath for the DEFAULT file; every test
// passes an explicit path, so a stub is enough to import the module.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import {
  FB_SNAPSHOT_LIMITS,
  appendFbSnapshot,
  isFacebookSnapshotUrl,
  listFbSnapshots,
  normalizeFbSnapshots,
  validateFbSnapshotInput
} from '../fbSnapshots'

const tempDirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-snapshots-'))
  tempDirs.push(dir)
  return path.join(dir, 'fb-snapshots.json')
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

describe('isFacebookSnapshotUrl', () => {
  it('accepts facebook.com and subdomains over http(s)', () => {
    expect(isFacebookSnapshotUrl('https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1')).toBe(true)
    expect(isFacebookSnapshotUrl('https://business.facebook.com/latest/home')).toBe(true)
    expect(isFacebookSnapshotUrl('http://facebook.com/')).toBe(true)
  })

  it('rejects look-alikes, other hosts, and non-http schemes', () => {
    for (const bad of [
      'https://facebook.evil.com/',
      'https://notfacebook.com/',
      'https://meta.com/',
      'ftp://facebook.com/',
      'not a url'
    ]) {
      expect(isFacebookSnapshotUrl(bad)).toBe(false)
    }
  })
})

describe('validateFbSnapshotInput', () => {
  it('accepts a facebook snapshot and bounds title and text', () => {
    const input = validateFbSnapshotInput({
      url: 'https://adsmanager.facebook.com/manage',
      title: 't'.repeat(600),
      text: 'x'.repeat(FB_SNAPSHOT_LIMITS.maxTextChars + 50)
    })
    expect(input).not.toBeNull()
    expect((input as { title: string }).title).toHaveLength(FB_SNAPSHOT_LIMITS.maxTitleLength)
    expect((input as { text: string }).text).toHaveLength(FB_SNAPSHOT_LIMITS.maxTextChars)
  })

  it('rejects non-facebook urls, missing fields, and oversized urls', () => {
    expect(validateFbSnapshotInput({ url: 'https://meta.com/', title: 't', text: 'x' })).toBeNull()
    expect(validateFbSnapshotInput({ url: 'https://facebook.com/', title: 't' })).toBeNull()
    expect(
      validateFbSnapshotInput({ url: `https://facebook.com/${'a'.repeat(2100)}`, title: 't', text: 'x' })
    ).toBeNull()
  })
})

describe('normalizeFbSnapshots', () => {
  it('drops invalid entries, sorts oldest-first, and prunes to the bound', () => {
    const entries = [
      { id: 'c', capturedAt: '2026-09-11T03:00:00.000Z', url: 'https://facebook.com/', title: 'c', text: '3' },
      { id: 'a', capturedAt: '2026-09-11T01:00:00.000Z', url: 'https://facebook.com/', title: 'a', text: '1' },
      { id: 'bad', capturedAt: 'nope', url: 'https://facebook.com/', title: 'x', text: '-' },
      { id: 'b', capturedAt: '2026-09-11T02:00:00.000Z', url: 'https://facebook.com/', title: 'b', text: '2' }
    ]
    const normalized = normalizeFbSnapshots(entries, 2)
    expect(normalized.map((e) => e.id)).toEqual(['b', 'c'])
  })
})

describe('appendFbSnapshot / listFbSnapshots', () => {
  it('round-trips entries newest-first in a valid JSON store', () => {
    const file = tempFile()
    const first = appendFbSnapshot(
      { url: 'https://adsmanager.facebook.com/campaigns', title: '广告管理工具', text: 'spend 12.30' },
      file
    )
    expect(first.ok).toBe(true)
    const second = appendFbSnapshot(
      { url: 'https://adsmanager.facebook.com/adsets', title: '广告组', text: 'spend 45.60' },
      file
    )
    expect(second.ok).toBe(true)

    // Same-millisecond appends tie on capturedAt, so assert membership and
    // non-strict ordering; the strict newest-first logic is covered by the
    // normalize test with distinct timestamps.
    const listed = listFbSnapshots(file)
    expect(listed).toHaveLength(2)
    expect(new Set(listed.map((e) => e.title))).toEqual(new Set(['广告管理工具', '广告组']))
    expect(new Set(listed.map((e) => e.text))).toEqual(new Set(['spend 12.30', 'spend 45.60']))
    expect(listed[0].capturedAt >= listed[1].capturedAt).toBe(true)

    const stored = JSON.parse(readFileSync(file, 'utf-8')) as unknown[]
    expect(Array.isArray(stored)).toBe(true)
  })

  it('fails closed on a corrupt store instead of rewriting it', () => {
    const file = tempFile()
    writeFileSync(file, '{not json', 'utf-8')
    const result = appendFbSnapshot(
      { url: 'https://facebook.com/', title: 't', text: 'x' },
      file
    )
    expect(result.ok).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe('{not json')
  })

  it('rejects invalid input without touching the store', () => {
    const file = tempFile()
    const result = appendFbSnapshot({ url: 'https://meta.com/', title: 't', text: 'x' }, file)
    expect(result).toEqual({ ok: false, error: 'invalid-snapshot' })
    expect(listFbSnapshots(file)).toEqual([])
  })
})
