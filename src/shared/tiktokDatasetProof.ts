import type { BoardDataset } from './types'

export interface TikTokDatasetProofWindow { advertiserId: string; startDate: string; endDate: string }
export interface TikTokDatasetProof extends TikTokDatasetProofWindow { digest: string }

/** Canonical account projection used identically by Main and the renderer. */
export function buildTikTokDatasetProofPayloads(dataset: BoardDataset, windows: TikTokDatasetProofWindow[]): Array<TikTokDatasetProofWindow & { payload: string }> {
  const idIndex = dataset.columns.findIndex((column) => column.name === '广告主ID' && column.type === 'text')
  const dateIndex = dataset.columns.findIndex((column) => column.name === '日期' && column.type === 'date')
  if (!dataset.id || idIndex < 0 || dateIndex < 0 || !windows.length || new Set(windows.map((window) => window.advertiserId)).size !== windows.length) throw new Error('invalid TikTok proof scope')
  const validDate = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  for (const window of windows) if (!/^[1-9]\d{0,24}$/.test(window.advertiserId) || !validDate(window.startDate) || !validDate(window.endDate) || window.startDate > window.endDate) throw new Error('invalid TikTok proof scope')
  const byAccount = new Map(windows.map((window) => [window.advertiserId, { window, rows: [] as string[] }]))
  for (const row of dataset.rows) {
    const bucket = byAccount.get(String(row[idIndex]))
    const date = String(row[dateIndex])
    if (bucket && date >= bucket.window.startDate && date <= bucket.window.endDate) bucket.rows.push(JSON.stringify(row))
  }
  return windows.map((window) => ({
    advertiserId: window.advertiserId,
    startDate: window.startDate,
    endDate: window.endDate,
    payload: JSON.stringify([dataset.id, dataset.columns, window.advertiserId, window.startDate, window.endDate, byAccount.get(window.advertiserId)!.rows.sort()])
  }))
}

/** Stable SHA-256 proofs over each account's full rows, columns and date window. */
export async function buildTikTokDatasetProofs(dataset: BoardDataset, windows: TikTokDatasetProofWindow[]): Promise<TikTokDatasetProof[]> {
  const payloads = buildTikTokDatasetProofPayloads(dataset, windows)
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 unavailable')
  const encoder = new TextEncoder()
  return Promise.all(payloads.map(async ({ payload, ...window }) => {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(payload))
    return { ...window, digest: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
  }))
}
