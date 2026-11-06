import { useSyncExternalStore } from 'react'
import type { BoardDataset } from '@shared/types'
import type { MetaReadingSummary } from '@shared/metaReading'

let datasets: BoardDataset[] = []
const listeners = new Set<() => void>()
export const metaDatasetId = (id: string) => `meta-reading:${id}`
export function publishMetaReading(id: string, summary: MetaReadingSummary | null): void {
  datasets = datasets.filter(dataset => dataset.id !== metaDatasetId(id))
  if (summary) {
    // A missing metric invalidates that entire column, never silently sums a partial total.
    const metrics = (['spend', 'impressions', 'clicks'] as const).filter(key => summary.rows.every(row => row[key] !== null))
    datasets = [...datasets, {
      id: metaDatasetId(id), name: `Meta Ads · ${summary.account.name}`, createdAt: summary.readAt,
      columns: [{ name: 'date', type: 'date' }, { name: 'account', type: 'text' }, { name: 'currency', type: 'text' }, ...metrics.map(name => ({ name, type: 'number' as const }))],
      rows: summary.rows.map(row => [row.date, summary.account.name, summary.account.currency ?? '', ...metrics.map(key => row[key]!)])
    }]
  }
  listeners.forEach(listener => listener())
}
export function useMetaDatasets(): BoardDataset[] {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, () => datasets, () => datasets)
}
