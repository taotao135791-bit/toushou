import { describe, expect, it } from 'vitest'
import {
  normalizeTikTokAdvertiserId,
  normalizeTikTokAdvertiserIds,
  parseTikTokAdvertiserIdList
} from '../tiktokReport'

describe('TikTok advertiser ids', () => {
  it('keeps 19-digit ids as strings and drops unsafe JSON numbers', () => {
    const big = '7300000000000000001'
    expect(normalizeTikTokAdvertiserId(big)).toBe(big)
    expect(normalizeTikTokAdvertiserId(Number(big))).toBeNull()
    expect(normalizeTikTokAdvertiserId(7300002)).toBe('7300002')
    expect(normalizeTikTokAdvertiserIds([big, 7300002, 'bad', big])).toEqual([big, '7300002'])
  })

  it('parses a comma-separated list and rejects junk', () => {
    expect(parseTikTokAdvertiserIdList('7300001, 7300002，7300001')).toEqual(['7300001', '7300002'])
    expect(parseTikTokAdvertiserIdList('')).toEqual([])
    expect(parseTikTokAdvertiserIdList(' , ；')).toEqual([])
    expect(parseTikTokAdvertiserIdList('7300001; drop table')).toBeNull()
    expect(parseTikTokAdvertiserIdList('7'.repeat(401))).toBeNull()
  })
})
