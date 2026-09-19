import { describe, expect, it } from 'vitest'
import { parseFbAccountBalanceSnapshot } from './fbBillingParser'

const URL =
  'https://adsmanager.facebook.com/adsmanager/billing_hub/payment_settings/?asset_id=27893958520273993&business_id=1734414010144999'
const OVERVIEW_URL =
  'https://adsmanager.facebook.com/adsmanager/manage/accounts?act=27893958520273993&business_id=1734414010144999'

describe('parseFbAccountBalanceSnapshot', () => {
  it('reads a labeled Chinese account balance adjacent to its amount', () => {
    const result = parseFbAccountBalanceSnapshot(
      {
        url: URL,
        text: ['COOPLAY-ADT-AND-03 (27893958520273993)', '账户余额', '$1,234.56'].join('\n'),
        observedAt: Date.parse('2026-09-19T06:00:00.000Z')
      },
      '27893958520273993'
    )
    expect(result).toMatchObject({
      kind: 'ok',
      balance: {
        kind: 'available',
        amount: 1234.56,
        currency: 'USD',
        amountText: '$1,234.56',
        label: '账户余额'
      }
    })
  })

  it('reads an English prepaid balance after the amount and identifies the account from the URL', () => {
    const result = parseFbAccountBalanceSnapshot(
      { url: URL, text: ['Billing', 'US$2,345.67', 'Prepaid balance'].join('\n') },
      '27893958520273993'
    )
    expect(result).toMatchObject({ kind: 'ok', balance: { amount: 2345.67, currency: 'USD', kind: 'available' } })
  })

  it('derives Account Overview available spend from its labeled limit and spend', () => {
    const result = parseFbAccountBalanceSnapshot(
      {
        url: OVERVIEW_URL,
        text: [
          'COOPLAY-ADT-AND-03',
          '账户花费限额:',
          '$4,000.01',
          '| 已花费$3,044.69 过去 7 天的已花费金额 : $1,137.39'
        ].join('\n')
      },
      '27893958520273993'
    )
    expect(result).toMatchObject({
      kind: 'ok',
      balance: {
        kind: 'available',
        amount: 955.32,
        currency: 'USD',
        amountText: '$955.32',
        label: '账户花费限额剩余'
      }
    })
  })

  it('refuses a page for another ad account', () => {
    const result = parseFbAccountBalanceSnapshot(
      { url: URL, text: ['广告账户编号：2131017261144314', '账户余额', '$10.00'].join('\n') },
      '27893958520273993'
    )
    expect(result).toEqual({ kind: 'account-mismatch' })
  })

  it('refuses unlabeled or ambiguous numbers', () => {
    expect(parseFbAccountBalanceSnapshot({ url: URL, text: '$99.00' }, '27893958520273993')).toEqual({
      kind: 'balance-not-found'
    })
    expect(
      parseFbAccountBalanceSnapshot({ url: URL, text: ['账户消费限额', '$500.00'].join('\n') }, '27893958520273993')
    ).toEqual({ kind: 'balance-not-found' })
  })
})
