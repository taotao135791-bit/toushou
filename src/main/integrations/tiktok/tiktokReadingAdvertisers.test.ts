import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-unused' } }))

import { listTikTokReadingAdvertisers, setTikTokReadingAdvertisers } from './tiktokReadingAdvertisers'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tt-reading-advertisers-'))
  file = path.join(dir, 'tiktok-reading-advertisers.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('tiktok reading advertisers store', () => {
  it('starts empty and saves a comma-separated list', () => {
    expect(listTikTokReadingAdvertisers(file)).toEqual([])
    const saved = setTikTokReadingAdvertisers({ advertiserIds: '7300001, 7300002' }, file)
    expect(saved).toEqual({ ok: true, selected: ['7300001', '7300002'] })
    expect(listTikTokReadingAdvertisers(file)).toEqual(['7300001', '7300002'])
  })

  it('clears the list when the text is blank', () => {
    setTikTokReadingAdvertisers({ advertiserIds: '7300001' }, file)
    expect(setTikTokReadingAdvertisers({ advertiserIds: '  ' }, file)).toEqual({ ok: true, selected: [] })
    expect(listTikTokReadingAdvertisers(file)).toEqual([])
  })

  it('rejects a malformed list without writing', () => {
    expect(setTikTokReadingAdvertisers({ advertiserIds: '7300001; drop table' }, file)).toEqual({
      ok: false,
      error: 'invalid-input'
    })
    expect(listTikTokReadingAdvertisers(file)).toEqual([])
  })
  it('does not turn corrupt or oversized saved selections into an all-account scope', () => {
    writeFileSync(file, '{bad json')
    expect(() => listTikTokReadingAdvertisers(file)).toThrow('tiktok-advertiser-selection-unavailable')
    writeFileSync(file, JSON.stringify({ advertiserIds: Array.from({ length: 501 }, (_, i) => String(i + 1)) }))
    expect(() => listTikTokReadingAdvertisers(file)).toThrow('tiktok-advertiser-selection-unavailable')
  })
  it('accepts 500 explicit IDs and rejects a 501st or separators alone without changing selection', () => {
    const ids = Array.from({ length: 500 }, (_, i) => String(7300000000 + i))
    expect(setTikTokReadingAdvertisers({ advertiserIds: ids.join(', ') }, file)).toEqual({ ok: true, selected: ids })
    expect(listTikTokReadingAdvertisers(file)).toEqual(ids)
    expect(setTikTokReadingAdvertisers({ advertiserIds: [...ids, '9999999999'].join(', ') }, file)).toEqual({ ok: false, error: 'invalid-input' })
    expect(setTikTokReadingAdvertisers({ advertiserIds: ',,,' }, file)).toEqual({ ok: false, error: 'invalid-input' })
    expect(listTikTokReadingAdvertisers(file)).toEqual(ids)
  })
})
