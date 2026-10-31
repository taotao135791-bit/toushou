import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TikTokAccountOptions, TikTokAccountPicker, discoverPickerAccounts, filterPickerAccounts, parsePickerAccount, type TikTokAccountPickerLabels } from './TikTokAccountPicker'

const labels: TikTokAccountPickerLabels = {
  title: 'Choose a scope', description: 'Choose one account or the connection scope.',
  accountLabel: 'Account name or ID', accountPlaceholder: 'Search or enter an ID', manualHint: 'Authorization is checked on reading.',
  loading: 'Discovering', empty: 'No accounts found', discoveryError: 'Discovery failed', namesIncomplete: 'Some names unavailable', noMatch: 'No matches', retry: 'Retry',
  invalidId: 'Invalid account ID', readOne: 'Read one', readAll: 'Inspect selected accounts', readAllHint: 'Uses the connection scope.'
}

describe('TikTok account picker', () => {
  it('maps display names to authoritative granted string IDs and supports name/ID search', async () => {
    const discover = vi.fn(async () => ({ selected: ['999'], granted: ['101', '202', '303'], accounts: [
      { advertiserId: '101', name: 'Fixture Alpha' }, { advertiserId: '202', name: 'Fixture Alpha' }, { advertiserId: '303', name: null }, { advertiserId: '999', name: 'Not Granted' }
    ], namesIncomplete: true }))
    const found = await discoverPickerAccounts(discover)
    expect(found).toEqual({ accounts: [{ advertiserId: '101', name: 'Fixture Alpha' }, { advertiserId: '202', name: 'Fixture Alpha' }, { advertiserId: '303', name: null }], namesIncomplete: true })
    expect(filterPickerAccounts(found.accounts, 'ALPHA').map(account => account.advertiserId)).toEqual(['101', '202'])
    expect(filterPickerAccounts(found.accounts, '20').map(account => account.advertiserId)).toEqual(['202'])
    expect(filterPickerAccounts(found.accounts, 'not granted')).toEqual([])
    expect(parsePickerAccount('Fixture Alpha')).toBeNull()
    expect(discover).toHaveBeenCalledOnce()
  })
  it('shows IDs for missing, conflicting or unavailable names and allows retry at the caller', async () => {
    const found = await discoverPickerAccounts(async () => ({ selected: [], granted: ['101', '202', '303'], accounts: [
      { advertiserId: '101', name: 'One' }, { advertiserId: '101', name: 'Different' }, { advertiserId: '202', name: null }
    ], namesIncomplete: true }))
    expect(found).toEqual({ accounts: [{ advertiserId: '101', name: null }, { advertiserId: '202', name: null }, { advertiserId: '303', name: null }], namesIncomplete: true })
    expect(await discoverPickerAccounts(async () => ({ selected: [], granted: ['101'] }))).toEqual({ accounts: [{ advertiserId: '101', name: null }], namesIncomplete: true })
    const html = renderToStaticMarkup(createElement(TikTokAccountOptions, { accounts: [{ advertiserId: '101', name: 'Fixture Alpha' }, { advertiserId: '202', name: null }], selectedId: null, busy: false, onSelect: () => {} }))
    expect(html).toContain('Fixture Alpha')
    expect(html).toContain('101')
    expect(html).toContain('202')
  })
  it('reports invalid grant lists instead of silently broadening scope', async () => {
    await expect(discoverPickerAccounts(async () => { throw new Error('unavailable') })).rejects.toThrow()
    await expect(discoverPickerAccounts(async () => ({ selected: [], granted: ['101', 'bad'] }))).rejects.toThrow('invalid-account-discovery')
    await expect(discoverPickerAccounts(async () => ({ selected: [], granted: Array.from({ length: 501 }, (_, i) => String(i + 1)) }))).rejects.toThrow('invalid-account-discovery')
    expect(await discoverPickerAccounts(async () => ({ selected: [], granted: [] }))).toEqual({ accounts: [], namesIncomplete: false })
  })
  it('accepts a single numeric string and rejects malformed or multiple IDs', () => {
    expect(parsePickerAccount(' 7300001 ')).toBe('7300001')
    for (const input of ['', '0', '01', '7300001,7300002', '7300001\n7300002', '9'.repeat(26), '123x']) expect(parsePickerAccount(input)).toBeNull()
  })
  it('renders distinct explicit actions without triggering discovery or either reading', () => {
    const discover = vi.fn(async () => ({ selected: [], granted: ['101'] }))
    const onReadOne = vi.fn(), onReadAll = vi.fn()
    const html = renderToStaticMarkup(createElement(TikTokAccountPicker, { labels, discover, onReadOne, onReadAll }))
    expect(html).toContain('Read one')
    expect(html).toContain('Inspect selected accounts')
    expect(html).toContain('Discovering')
    expect(html).toMatch(/type="submit" disabled=""/)
    expect(discover).not.toHaveBeenCalled()
    expect(onReadOne).not.toHaveBeenCalled()
    expect(onReadAll).not.toHaveBeenCalled()
  })
})
