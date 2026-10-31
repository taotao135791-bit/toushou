import type { ReadingSnapshot, ReadingSnapshotAccount } from '@shared/readingSnapshot'
import { previousEqualWindow, isTikTokTodayFailure, type TikTokTodayReading, type TodayWindow } from '@shared/todayReading'
import type { TodayFacebookRow } from './todayFacebook'

/** Snapshot only the displayed scope; failed rows never become a valid zero. */
export function snapshotToday(input: {
  rangeLabel: string; window: TodayWindow; capturedAt: number
  facebook: TodayFacebookRow[] | null; tiktok: TikTokTodayReading | null
  facebookLoadError?: boolean
  tiktokFailure?: { code: string } | null
  facebookFailures?: Readonly<Record<string, string | null>>
  tiktokFailures?: Readonly<Record<string, { code: string } | null>>
  updatedAt?: Readonly<Record<string, number>>
}): ReadingSnapshot {
  const accounts: ReadingSnapshotAccount[] = []
  if (input.facebookLoadError) accounts.push({ platform: 'facebook', accountId: null, name: 'Facebook', status: 'failed', statusDetail: 'account-list-unavailable', window: input.window, previousWindow: null, sourceAt: null, timezone: null, currency: null, spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null })
  if (input.tiktokFailure) accounts.push({ platform: 'tiktok', accountId: null, name: 'TikTok', status: 'failed', statusDetail: input.tiktokFailure.code, window: input.window, previousWindow: null, sourceAt: null, timezone: null, currency: null, spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null })
  for (const row of input.facebook ?? []) {
    const failure = input.facebookFailures?.[row.account.act] ?? row.readError
    const status = failure ? 'failed' : row.spend === null ? 'unavailable' : 'ok'
    accounts.push({ platform: 'facebook', accountId: row.account.act, name: row.account.alias, status,
      statusDetail: failure ?? (status === 'unavailable' ? 'no-reading-for-window' : null), window: input.window,
      previousWindow: row.previousSpend !== null ? previousEqualWindow(input.window) : null, sourceAt: row.capturedAt ? Date.parse(row.capturedAt) : null, timezone: null,
      currency: row.currency, spend: status === 'ok' ? row.spend : null, previousSpend: status === 'ok' ? row.previousSpend : null,
      impressions: status === 'ok' ? row.impressions : null, clicks: status === 'ok' ? row.clicks : null,
      conversions: status === 'ok' ? row.conversions : null, resultType: row.resultType })
  }
  for (const account of input.tiktok?.accounts ?? []) {
    const failure = input.tiktokFailures?.[account.advertiserId]
    const failed = isTikTokTodayFailure(account)
    const status = failure || failed ? (failed && account.detail === 'account-batch-not-attempted' ? 'unattempted' : 'failed') : 'ok'
    accounts.push({ platform: 'tiktok', accountId: account.advertiserId, name: account.name, status,
      statusDetail: failure?.code ?? (failed ? account.detail ?? account.error : null),
      window: !failed ? account.window ?? input.tiktok!.window : input.tiktok!.window,
      previousWindow: !failed ? account.previousWindow ?? input.tiktok!.previousWindow : null,
      sourceAt: failed ? null : input.updatedAt?.[account.advertiserId] ?? input.tiktok!.generatedAt,
      timezone: account.timezone ?? null, currency: account.currency,
      spend: status === 'ok' && !failed ? account.spend : null, previousSpend: status === 'ok' && !failed ? account.previousSpend : null,
      impressions: status === 'ok' && !failed ? account.impressions : null, clicks: status === 'ok' && !failed ? account.clicks : null,
      conversions: status === 'ok' && !failed ? account.conversions : null })
  }
  return { kind: 'reading-snapshot', version: 1, rangeLabel: input.rangeLabel, window: input.window, capturedAt: input.capturedAt, accounts }
}

export function anonymousReadingDraft(snapshot: ReadingSnapshot, language: 'zh' | 'en'): { text: string; mappings: string[] } {
  const zh = language === 'zh'
  const counters: Record<string, number> = {}
  const mappings: string[] = []
  const lines = snapshot.accounts.slice(0, 50).map((a) => {
    const index = counters[a.platform] = (counters[a.platform] ?? 0) + 1
    const alias = `${a.platform === 'facebook' ? 'Facebook' : a.platform === 'tiktok' ? 'TikTok' : 'Google'} ${zh ? '账户' : 'account'} ${index}`
    mappings.push(`${alias} → ${a.name ?? a.accountId ?? '—'}`)
    if (a.status !== 'ok') return `${alias}: ${zh ? '无本次有效读数' : 'no valid current reading'} (${a.status})`
    return `${alias} | ${a.window.start} – ${a.window.end} | ${a.currency ?? (zh ? '币种未知' : 'currency unknown')} | ${zh ? '消耗' : 'spend'} ${a.spend ?? '—'} | ${zh ? '上期' : 'prior spend'} ${a.previousSpend ?? '—'} | ${zh ? '展示' : 'impressions'} ${a.impressions ?? '—'} | ${zh ? '点击' : 'clicks'} ${a.clicks ?? '—'} | ${zh ? '结果' : 'results'} ${a.conversions ?? '—'}`
  })
  const omitted = snapshot.accounts.length - lines.length
  return { text: [zh ? '只分析以下脱敏读数，不调用工具、不修改广告；缺失数据视为未知。不同平台的结果定义、币种与日期分别判断，不跨币种合计。' : 'Analyze only these anonymized readings. Do not call tools or modify ads. Missing data is unknown. Keep platform definitions, currencies and date windows separate.',
    `${snapshot.rangeLabel}; ${zh ? '保存于' : 'captured'} ${new Date(snapshot.capturedAt).toISOString()}`,
    ...lines, ...(omitted ? [zh ? `其余 ${omitted} 个账户未包含，请缩小范围后分别分析。` : `${omitted} additional accounts omitted; narrow the scope to analyze them.`] : [])].join('\n'), mappings }
}
