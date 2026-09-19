import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import {
  FB_READING_ACCOUNT_LIMITS,
  mergeFbReadingAccounts,
  parseFbReadingAccounts
} from '../fbReadingAccounts'

describe('fb reading account registry (pure halves)', () => {
  it('parses valid entries and drops malformed or duplicate ones', () => {
    const json = JSON.stringify([
      { id: 'a1', alias: '三国IOS', act: '2131017261144314', businessId: '1734414010144999', createdAt: 1 },
      { id: 'a1', alias: 'dup id', act: '999', businessId: null, createdAt: 2 },
      { id: 'a2', alias: '', act: '123456', businessId: null, createdAt: 3 },
      { id: 'a3', alias: 'bad act', act: 'abc', businessId: null, createdAt: 4 },
      { id: 'a4', alias: 'dup act', act: '2131017261144314', businessId: null, createdAt: 5 },
      'junk'
    ])
    const entries = parseFbReadingAccounts(json)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'a1', alias: '三国IOS', act: '2131017261144314' })
  })

  it('returns empty for unreadable documents', () => {
    expect(parseFbReadingAccounts('not json')).toEqual([])
    expect(parseFbReadingAccounts('{}')).toEqual([])
  })

  it('merges by act, validates refs, and caps the registry size', () => {
    const existing = Array.from({ length: FB_READING_ACCOUNT_LIMITS.maxAccounts - 1 }, (_, index) => ({
      id: `id-${index}`,
      alias: `acc-${index}`,
      act: String(100000 + index),
      businessId: null,
      createdAt: index
    }))
    const merged = mergeFbReadingAccounts(existing, [
      { alias: '新账户', act: '999999', businessId: null },
      { alias: '', act: '888888', businessId: null },
      { alias: '坏ID', act: 'abc', businessId: null },
      { alias: '坏BM', act: '777777', businessId: 'xyz' }
    ])
    expect(merged.added).toEqual([{ alias: '新账户', act: '999999', businessId: null }])
    expect(merged.accounts).toHaveLength(FB_READING_ACCOUNT_LIMITS.maxAccounts)

    const over = mergeFbReadingAccounts(merged.accounts, [{ alias: '再多一个', act: '666666', businessId: null }])
    expect(over.added).toEqual([])
  })
})
