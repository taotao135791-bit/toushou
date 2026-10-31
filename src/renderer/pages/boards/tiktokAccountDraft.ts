import { formatReadingWindow, formatSpendDelta, type TikTokTodayAccountReading, type TodayWindow } from '@shared/todayReading'
import { formatTikTokAmount, formatTikTokCount, formatTikTokRate } from '@shared/tiktokReport'

/** A compact composer draft constructed from exactly one account. */
export function buildTikTokAccountDraft(
  language: 'zh' | 'en',
  account: TikTokTodayAccountReading,
  window: TodayWindow,
  previousWindow: TodayWindow,
  generatedAt: number
): string {
  const currency = account.currency ?? (language === 'zh' ? '币种未知' : 'currency unknown')
  const delta = formatSpendDelta(account.spend, account.previousSpend) ?? '—'
  const moves = account.campaigns.slice(0, 3).map((move, index) => `${language === 'zh' ? '活动' : 'Campaign'} ${String.fromCharCode(65 + index)} ${formatSpendDelta(move.spend, move.previousSpend) ?? '—'}`).join('; ') || '—'
  const measured = new Date(generatedAt)
  const captured = Number.isFinite(measured.valueOf()) ? measured.toISOString() : '—'
  if (language === 'zh') return [
    '请只分析这个 TikTok 账户提供的读数，不调用工具、不修改广告；未列出的数据视为未知。',
    `账户：所选 TikTok 账户；时间 ${formatReadingWindow(window)}；对比 ${formatReadingWindow(previousWindow)}；读取于 ${captured}`,
    `消耗 ${formatTikTokAmount(account.spend)} ${currency}；较上期 ${delta}；展示 ${formatTikTokCount(account.impressions)}；点击 ${formatTikTokCount(account.clicks)}；点击率 ${formatTikTokRate(account.clicks, account.impressions)}；转化 ${formatTikTokCount(account.conversions)}`,
    `活动变动（最多 3 条）：${moves}`
  ].join('\n')
  return [
    'Analyze only this TikTok account’s provided data. Do not call tools or modify ads; treat omitted data as unknown.',
    `Account: selected TikTok account; window ${formatReadingWindow(window)}; comparison ${formatReadingWindow(previousWindow)}; read ${captured}`,
    `Spend ${formatTikTokAmount(account.spend)} ${currency}; change ${delta}; impressions ${formatTikTokCount(account.impressions)}; clicks ${formatTikTokCount(account.clicks)}; CTR ${formatTikTokRate(account.clicks, account.impressions)}; conversions ${formatTikTokCount(account.conversions)}`,
    `Campaign changes (up to 3): ${moves}`
  ].join('\n')
}

