import type { BoardDataset } from './types'
import type { MetaReadingSummary } from './metaReading'

/** Native and Main views use one normalization; unknown daily values never become partial totals. */
export function metaReadingDataset(readerId: string, summary: MetaReadingSummary): BoardDataset {
  const metrics = (['spend', 'impressions', 'clicks'] as const).filter(key => summary.rows.every(row => typeof row[key] === 'number' && Number.isFinite(row[key])))
  return {
    id: `meta-reading:${readerId}`, name: `Meta Ads · ${summary.account.name}`, createdAt: summary.readAt,
    columns: [{ name: 'date', type: 'date' }, { name: 'account', type: 'text' }, { name: 'account_id', type: 'text' }, { name: 'currency', type: 'text' }, ...metrics.map(name => ({ name, type: 'number' as const }))],
    rows: summary.rows.map(row => [row.date, summary.account.name, summary.account.id, summary.account.currency ?? '', ...metrics.map(key => row[key]!)])
  }
}
