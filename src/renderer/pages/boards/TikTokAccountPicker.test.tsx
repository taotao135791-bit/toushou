import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TikTokAccountPicker, discoverPickerAccounts, parsePickerAccount, type TikTokAccountPickerLabels } from './TikTokAccountPicker'

const labels: TikTokAccountPickerLabels = {
  title: 'Choose a scope', description: 'Choose one account or the connection scope.',
  accountLabel: 'Account ID', accountPlaceholder: 'Enter an ID', manualHint: 'Authorization is checked on reading.',
  loading: 'Discovering', empty: 'No accounts found', discoveryError: 'Discovery failed', retry: 'Retry',
  invalidId: 'Invalid account ID', readOne: 'Read one', readAll: 'Inspect selected accounts', readAllHint: 'Uses the connection scope.'
}

describe('TikTok account picker', () => {
  it('discovers only valid authorized IDs and does not use the saved connection selection', async () => {
    const discover = vi.fn(async () => ({ selected: ['999'], granted: ['101', '202', '101'] }))
    expect(await discoverPickerAccounts(discover)).toEqual(['101', '202'])
    expect(discover).toHaveBeenCalledOnce()
  })
  it('reports discovery failures or malformed lists rather than silently dropping accounts', async () => {
    await expect(discoverPickerAccounts(async () => { throw new Error('unavailable') })).rejects.toThrow()
    await expect(discoverPickerAccounts(async () => ({ selected: [], granted: ['101', 'bad'] }))).rejects.toThrow('invalid-account-discovery')
    await expect(discoverPickerAccounts(async () => ({ selected: [], granted: Array.from({ length: 501 }, (_, i) => String(i + 1)) }))).rejects.toThrow('invalid-account-discovery')
    expect(await discoverPickerAccounts(async () => ({ selected: [], granted: [] }))).toEqual([])
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
