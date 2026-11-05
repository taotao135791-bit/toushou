import type { BoardMasterScope } from './types'

export type MetaReadingRange = BoardMasterScope['range']
export interface MetaReadingAccount { id: string; name: string; currency: string | null; timezone: string | null }
export interface MetaReadingRow { date: string; spend: number | null; impressions: number | null; clicks: number | null }
export interface MetaReadingSummary {
  account: MetaReadingAccount
  range: MetaReadingRange
  rows: MetaReadingRow[]
  readAt: number
  start: string | null
  end: string | null
}
export type MetaReadingResult<T> = { ok: true; data: T } | { ok: false; error: string }
export function isMetaReadingRange(value: unknown): value is MetaReadingRange {
  return ['today', 'yesterday', 'last3', 'last7', 'last30'].includes(value as string)
}
export function isMetaAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^act_\d{1,30}$/.test(value)
}
