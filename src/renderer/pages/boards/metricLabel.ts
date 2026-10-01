import type { I18nKey } from '../../i18n'

/**
 * Single source of FB reading metric pill labels, shared by the board
 * master-scope popover and the widget config panel — the same metric must
 * not wear two names on the same screen.
 */
export function fbReadingMetricLabel(t: (key: I18nKey) => string, value: string): string {
  if (value === 'spend') return t('boards.reading.summary.metric.spend')
  if (value === 'balance') return t('boards.reading.balance.label')
  if (value === 'cpi') return t('boards.reading.summary.metric.cpi')
  if (value === 'cpm') return t('boards.reading.summary.metric.cpm')
  if (value === 'cpa') return t('boards.reading.summary.metric.cpa')
  return t('boards.reading.summary.metric.ctr')
}

export function fbReadingRangeLabel(t: (key: I18nKey) => string, range: string): string {
  if (range === 'today') return t('boards.master.range.today')
  if (range === 'last3') return t('boards.master.range.last3')
  if (range === 'last30') return t('boards.master.range.last30')
  return t('boards.master.range.last7')
}

export function ttReadingRangeLabel(t: (key: I18nKey) => string, range: string): string {
  if (range === '1') return t('boards.tt.range.1')
  if (range === '28') return t('boards.tt.range.28')
  return t('boards.tt.range.7')
}
