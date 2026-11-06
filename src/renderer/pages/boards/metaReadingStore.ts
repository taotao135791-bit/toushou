import { useSyncExternalStore } from 'react'
import type { BoardDataset } from '@shared/types'
import type { MetaReadingSummary } from '@shared/metaReading'
import { metaReadingDataset } from '@shared/metaReadingDataset'

let datasets: BoardDataset[] = []
const listeners = new Set<() => void>()
export const metaDatasetId = (id: string) => `meta-reading:${id}`
export function publishMetaReading(id: string, summary: MetaReadingSummary | null): void {
  datasets = datasets.filter(dataset => dataset.id !== metaDatasetId(id))
  if (summary) datasets = [...datasets, metaReadingDataset(id, summary)]
  listeners.forEach(listener => listener())
}
export function useMetaDatasets(): BoardDataset[] {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, () => datasets, () => datasets)
}
