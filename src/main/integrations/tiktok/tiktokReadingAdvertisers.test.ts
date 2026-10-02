import { mkdtempSync, rmSync } from 'node:fs'
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
})
