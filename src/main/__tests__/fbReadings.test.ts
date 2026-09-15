import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// fbReadings.ts only touches app.getPath for the DEFAULT file; tests pass an
// explicit path, so a stub is enough to import the module.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { parseFbAdsCampaignsSnapshot } from '../../shared/fbAdsParser'
import { REAL_CAMPAIGNS_TEXT, REAL_URL } from '../../shared/fbAdsParser.test'
import { appendFbReading, listFbReadings, normalizeFbReadings, toFbReadingEntry } from '../fbReadings'

const LAST_ROW = [
  'adtiger_三國點將令_IOS_MO/HK/TW_FB_aeo_Ricky_0825_001',
  '$933.76',
  '$15.31',
  '$17.88',
  '129',
  '应用内购买',
  '1,110',
  '2.13%',
  '$0.84',
  '61'
].join('\n')

const tempDirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-readings-'))
  tempDirs.push(dir)
  return path.join(dir, 'fb-readings.json')
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

function verifiedReading() {
  const reading = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: REAL_CAMPAIGNS_TEXT })
  expect(reading).not.toBeNull()
  return reading as NonNullable<typeof reading>
}

function brokenReading() {
  const reading = parseFbAdsCampaignsSnapshot({
    url: REAL_URL,
    text: REAL_CAMPAIGNS_TEXT.replace(LAST_ROW + '\n', '')
  })
  expect(reading).not.toBeNull()
  return reading as NonNullable<typeof reading>
}

describe('toFbReadingEntry', () => {
  it('accepts a fully verified reading and shapes it for history', () => {
    const entry = toFbReadingEntry(verifiedReading(), '2026-09-14T06:00:00.000Z')
    expect(entry).not.toBeNull()
    expect(entry?.accountId).toBe('2131017261144314')
    expect(entry?.totalSpend).toBe(3146.47)
    expect(entry?.rows).toHaveLength(8)
    expect(entry?.rows[1].spend).toBe(529.08)
  })

  it('refuses readings that failed any hard gate', () => {
    expect(toFbReadingEntry(brokenReading())).toBeNull()
    expect(toFbReadingEntry(null as never)).toBeNull()
  })
})

describe('normalizeFbReadings', () => {
  it('drops invalid entries and duplicate ids, prunes oldest beyond the bound', () => {
    const make = (id: string, at: string) => ({
      id,
      capturedAt: at,
      accountId: '2131017261144314',
      accountName: null,
      dateRangeLabel: '今天：2026年9月14日',
      campaignCount: 8,
      totalSpend: 3146.47,
      rows: [
        {
          name: 'camp',
          spend: 1,
          costPerResult: null,
          cpm: null,
          results: null,
          resultType: null,
          clicks: null,
          ctr: null,
          cpc: null,
          installs: null
        }
      ]
    })
    const kept = normalizeFbReadings(
      [
        make('b', '2026-09-14T02:00:00.000Z'),
        make('bad', 'nope'),
        make('a', '2026-09-14T01:00:00.000Z'),
        make('b', '2026-09-14T02:00:00.000Z'),
        make('c', '2026-09-14T03:00:00.000Z')
      ],
      2
    )
    expect(kept.map((e) => e.id)).toEqual(['b', 'c'])
  })
})

describe('appendFbReading / listFbReadings', () => {
  it('round-trips verified readings newest-first with an account filter', () => {
    const file = tempFile()
    expect(appendFbReading(verifiedReading(), file).ok).toBe(true)
    expect(appendFbReading(verifiedReading(), file).ok).toBe(true)

    const listed = listFbReadings(undefined, file)
    expect(listed).toHaveLength(2)
    expect(listed[0].id).not.toBe(listed[1].id)
    expect(listFbReadings('2131017261144314', file)).toHaveLength(2)
    expect(listFbReadings('999999999999', file)).toHaveLength(0)
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toBeInstanceOf(Array)
  })

  it('refuses unverified readings without touching the store', () => {
    const file = tempFile()
    const result = appendFbReading(brokenReading(), file)
    expect(result).toEqual({ ok: false, error: 'unverified-reading' })
    expect(listFbReadings(undefined, file)).toEqual([])
  })

  it('fails closed on a corrupt store instead of rewriting it', () => {
    const file = tempFile()
    writeFileSync(file, '{not json', 'utf-8')
    const result = appendFbReading(verifiedReading(), file)
    expect(result.ok).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe('{not json')
  })
})
