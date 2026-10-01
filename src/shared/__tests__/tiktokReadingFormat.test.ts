import { describe, expect, it } from 'vitest'
import {
  formatTikTokAmount,
  formatTikTokCostPerConversion,
  formatTikTokCount,
  formatTikTokRate
} from '../tiktokReport'

describe('TikTok reading display format', () => {
  it('groups amounts and counts without inventing a currency symbol', () => {
    expect(formatTikTokAmount(1234.5)).toBe('1,234.50')
    expect(formatTikTokAmount(0)).toBe('0.00')
    expect(formatTikTokCount(12000)).toBe('12,000')
  })

  it('treats a missing denominator as unknown instead of zero', () => {
    expect(formatTikTokRate(0, 0)).toBe('—')
    expect(formatTikTokRate(3, 100)).toBe('3.00%')
    expect(formatTikTokCostPerConversion(40, 0)).toBe('—')
    expect(formatTikTokCostPerConversion(40, 2)).toBe('20.00')
  })

  it('rejects non-finite numbers', () => {
    expect(formatTikTokAmount(Number.NaN)).toBe('—')
    expect(formatTikTokCount(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
