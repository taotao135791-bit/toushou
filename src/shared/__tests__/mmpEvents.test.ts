import { describe, expect, it } from 'vitest'
import { joinMmpEventsToTikTokCampaignDays, type MmpEventAggregate, type TikTokCampaignDay } from '../mmpEvents'

const event: MmpEventAggregate = {
  source: 'appsflyer', mediaSource: 'tiktok', appId: 'synthetic.app', campaignId: '1234567890123456789',
  day: '2026-10-12', timezone: 'Etc/UTC', dateBasis: 'activity', metricBasis: 'activity',
  eventName: 'synthetic_purchase', count: 12, uniqueUsers: 8, revenue: null, currency: 'USD',
  partial: false, updatedAt: null,
}
const report: TikTokCampaignDay = {
  advertiserId: '12345', campaignId: '1234567890123456789', day: '2026-10-12',
  timezone: 'UTC', currency: 'USD', spend: 42,
}
const join = (item: MmpEventAggregate, rows: TikTokCampaignDay[] = [report]) => joinMmpEventsToTikTokCampaignDays([item], rows)[0]

describe('AppsFlyer to TikTok campaign-day association', () => {
  it('keeps the two event metrics, missing revenue and completeness distinct', () => {
    expect(join(event)).toEqual({ status: 'matched', event, report, moneyCompatibility: 'compatible' })
    const missing = { ...event, count: null, uniqueUsers: null, partial: null }
    expect(join(missing)).toMatchObject({ status: 'matched', event: { count: null, uniqueUsers: null, partial: null } })
    expect(join({ ...event, count: 0, uniqueUsers: 0 })).toMatchObject({ status: 'matched', event: { count: 0, uniqueUsers: 0 } })
  })

  it('does not infer an association from a name, another day, source or a rounded ID', () => {
    expect(join({ ...event, campaignId: '1234567890123456790' })).toMatchObject({ status: 'unmatched', reason: 'no-report' })
    expect(join({ ...event, campaignId: null })).toMatchObject({ status: 'incompatible', reason: 'missing-identity' })
    expect(join({ ...event, day: '2026-10-13' })).toMatchObject({ status: 'unmatched', reason: 'no-report' })
    expect(join({ ...event, mediaSource: 'other' })).toMatchObject({ status: 'incompatible', reason: 'unsupported-source' })
    expect(join({ ...event, day: '2026-02-30' })).toMatchObject({ status: 'incompatible', reason: 'invalid-date' })
  })

  it('does not treat install-day LTV or unknown attribution basis as activity-day data', () => {
    expect(join({ ...event, dateBasis: 'install', metricBasis: 'ltv' })).toMatchObject({ status: 'incompatible', reason: 'incompatible-date-basis' })
    expect(join({ ...event, dateBasis: null })).toMatchObject({ status: 'incompatible', reason: 'incompatible-date-basis' })
    expect(join({ ...event, metricBasis: null })).toMatchObject({ status: 'incompatible', reason: 'incompatible-date-basis' })
  })

  it('never shifts aggregated days between timezones or guesses missing zones', () => {
    expect(join({ ...event, timezone: 'UTC+08:00' })).toMatchObject({ status: 'incompatible', reason: 'timezone-mismatch' })
    expect(join({ ...event, timezone: null })).toMatchObject({ status: 'incompatible', reason: 'unknown-timezone' })
    expect(join(event, [{ ...report, timezone: null }])).toMatchObject({ status: 'incompatible', reason: 'unknown-timezone' })
    expect(join({ ...event, timezone: 'UTC+00:00' })).toMatchObject({ status: 'matched' })
  })

  it('flags unknown and mixed currency without changing or adding either amount', () => {
    expect(join({ ...event, revenue: 5, currency: null })).toMatchObject({ status: 'matched', moneyCompatibility: 'unknown', event: { revenue: 5 } })
    expect(join({ ...event, revenue: 5, currency: 'EUR' })).toMatchObject({ status: 'matched', moneyCompatibility: 'mismatch', report: { spend: 42 } })
  })

  it('retains separate apps, while duplicate event rows and campaign rows fail closed', () => {
    const otherApp = { ...event, appId: 'another.synthetic.app' }
    expect(joinMmpEventsToTikTokCampaignDays([event, otherApp], [report]).map(row => row.status)).toEqual(['matched', 'matched'])
    expect(joinMmpEventsToTikTokCampaignDays([event, { ...event, count: 99 }], [report])).toMatchObject([
      { status: 'ambiguous', reason: 'duplicate-event' }, { status: 'ambiguous', reason: 'duplicate-event' },
    ])
    expect(join(event, [report, { ...report, advertiserId: '67890' }])).toMatchObject({ status: 'ambiguous', reason: 'ambiguous-campaign' })
    expect(joinMmpEventsToTikTokCampaignDays([event, { ...event, dateBasis: 'install', metricBasis: 'ltv' }], [report])).toMatchObject([
      { status: 'matched' }, { status: 'incompatible', reason: 'incompatible-date-basis' },
    ])
  })

  it('rejects invalid numbers rather than converting them to zero', () => {
    expect(join({ ...event, count: Number.NaN })).toMatchObject({ status: 'incompatible', reason: 'invalid-metric' })
    expect(join({ ...event, uniqueUsers: -1 })).toMatchObject({ status: 'incompatible', reason: 'invalid-metric' })
    expect(join(event, [{ ...report, spend: Number.POSITIVE_INFINITY }])).toMatchObject({ status: 'incompatible', reason: 'invalid-metric' })
  })
})
