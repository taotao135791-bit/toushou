import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { buildTikTokDatasetProofPayloads, buildTikTokDatasetProofs } from '../tiktokDatasetProof'
import type { BoardDataset } from '../types'

const data: BoardDataset = { id: 'dataset', name: 'TikTok 报表', createdAt: 1, columns: [
  { name: '日期', type: 'date' }, { name: '广告主ID', type: 'text' }, { name: '活动ID', type: 'text' }, { name: '币种', type: 'text' }, { name: '消耗', type: 'number' }, { name: '账户时区', type: 'text' }
], rows: [ ['2026-10-24', '11', '1', 'USD', 5, 'UTC'], ['2026-10-25', '11', '2', 'USD', 7, 'UTC'], ['2026-10-24', '22', '3', 'EUR', 9, 'UTC'] ] }
const windows = [{ advertiserId: '11', startDate: '2026-10-24', endDate: '2026-10-30' }, { advertiserId: '22', startDate: '2026-10-24', endDate: '2026-10-30' }, { advertiserId: '33', startDate: '2026-10-24', endDate: '2026-10-30' }]

describe('TikTok dataset proof', () => {
  it('covers complete rows, columns and empty account scopes independently of row order', async () => {
    const proofs = await buildTikTokDatasetProofs(data, windows)
    expect(proofs.every((proof) => /^[0-9a-f]{64}$/.test(proof.digest))).toBe(true)
    const fromNode = buildTikTokDatasetProofPayloads(data, windows).map(({ payload, ...window }) => ({ ...window, digest: createHash('sha256').update(payload, 'utf8').digest('hex') }))
    expect(proofs).toEqual(fromNode)
    expect(await buildTikTokDatasetProofs({ ...data, rows: [...data.rows].reverse() }, windows)).toEqual(proofs)
    const changed = { ...data, rows: data.rows.map((row, index) => index === 0 ? [row[0], row[1], row[2], row[3], 8, row[5]] : row) }
    const updated = await buildTikTokDatasetProofs(changed, windows)
    expect(updated[0].digest).not.toBe(proofs[0].digest)
    expect(updated[1].digest).toBe(proofs[1].digest)
    expect(updated[2].digest).toBe(proofs[2].digest)
    expect((await buildTikTokDatasetProofs({ ...data, columns: [...data.columns].reverse() }, windows)).map((proof) => proof.digest)).not.toEqual(proofs.map((proof) => proof.digest))
  })

  it('rejects missing identity columns, duplicate accounts and missing SHA-256', async () => {
    await expect(buildTikTokDatasetProofs({ ...data, columns: [] }, windows)).rejects.toThrow()
    await expect(buildTikTokDatasetProofs(data, [windows[0], windows[0]])).rejects.toThrow()
    vi.stubGlobal('crypto', {})
    try { await expect(buildTikTokDatasetProofs(data, windows)).rejects.toThrow() } finally { vi.unstubAllGlobals() }
  })
})
