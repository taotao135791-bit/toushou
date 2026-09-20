import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { normalizeFbAccountBalances } from '../fbBalances'

describe('normalizeFbAccountBalances', () => {
  it('keeps only the newest valid entry per account', () => {
    const make = (id: string, at: string, account = '123456789') => ({
      id,
      accountId: account,
      kind: 'available' as const,
      amount: 10,
      currency: 'USD',
      amountText: '$10.00',
      label: '账户余额',
      capturedAt: at,
      sourceUrl: null
    })
    const kept = normalizeFbAccountBalances([make('old', '2026-09-18T00:00:00.000Z'), make('new', '2026-09-19T00:00:00.000Z'), make('bad', 'nope')])
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe('new')
  })
})
