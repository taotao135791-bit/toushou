import { describe, expect, it } from 'vitest'
import { fbAdsReadingTotalsMatch, parseFbAdsCampaignsSnapshot } from './fbAdsParser'
import { REAL_CAMPAIGNS_TEXT } from './fbAdsParser.test'

// Live capture taken minutes ago (2026-09-11 evening): identical numbers to
// the stored fixture (same 30-day window) but with extra filter-chip lines
// before the header block. Reuses the real fixture text plus those lines to
// prove the parser is robust to that UI variance.
const LIVE_TEXT = REAL_CAMPAIGNS_TEXT.replace(
  '搜索以按如下条件筛选：名称、编号或指标\n广告系列',
  '搜索以按如下条件筛选：名称、编号或指标\n投放状态\n目标\n花费\n操作\n名称、编号或指标\n广告系列'
)

describe('live capture', () => {
  it('parses the fresh page shape and matches visible numbers', () => {
    expect(LIVE_TEXT).not.toBe(REAL_CAMPAIGNS_TEXT)
    const reading = parseFbAdsCampaignsSnapshot({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2131017261144314',
      text: LIVE_TEXT
    })
    expect(reading).not.toBeNull()
    expect(reading?.rows).toHaveLength(8)
    expect(reading?.totalSpend).toBe(3146.47)
    expect(fbAdsReadingTotalsMatch(reading as never)).toBe(true)
    const active = reading?.rows[1]
    expect(active?.spend).toBe(529.08)
    expect(active?.clicks).toBe(788)
    expect(active?.installs).toBe(24)
  })
})
