import { describe, expect, it } from 'vitest'
import { gateBrowserUseRequest, isFacebookReadOnlyAction, parseBrowserUseRequest } from '../browserUse'

describe('isFacebookReadOnlyAction (hard FB read-only boundary)', () => {
  it('blocks click and type on any facebook.com surface', () => {
    for (const url of [
      'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1',
      'https://business.facebook.com/latest/home',
      'https://www.facebook.com/'
    ]) {
      expect(isFacebookReadOnlyAction('click', url)).toBe(true)
      expect(isFacebookReadOnlyAction('type', url)).toBe(true)
    }
  })

  it('allows reading actions on facebook and everything elsewhere', () => {
    for (const action of ['navigate', 'snapshot', 'screenshot', 'scroll', 'back', 'forward', 'wait'] as const) {
      expect(isFacebookReadOnlyAction(action, 'https://adsmanager.facebook.com/')).toBe(false)
    }
    expect(isFacebookReadOnlyAction('click', 'https://example.com/')).toBe(false)
    expect(isFacebookReadOnlyAction('type', 'https://adsmanager.facebook.com.evil.com/')).toBe(false)
    expect(isFacebookReadOnlyAction('click', null)).toBe(false)
  })
})

describe('gateBrowserUseRequest', () => {
  it('always admits navigate (it visibly reopens and takes ownership)', () => {
    expect(gateBrowserUseRequest('navigate', 'B', 'A', false)).toBeNull()
    expect(gateBrowserUseRequest('navigate', 'A', null, true)).toBeNull()
  })

  it('refuses every other action while the panel is hidden', () => {
    for (const action of ['snapshot', 'click', 'type', 'scroll', 'screenshot', 'back', 'forward', 'wait'] as const) {
      expect(gateBrowserUseRequest(action, 'A', 'A', false)).toBe('panel-hidden')
    }
  })

  it('refuses non-navigate actions from a session that does not own the panel', () => {
    expect(gateBrowserUseRequest('click', 'B', 'A', true)).toBe('panel-owned-by-another-session')
    expect(gateBrowserUseRequest('snapshot', 'A', 'B', true)).toBe('panel-owned-by-another-session')
  })

  it('admits the owner and unowned panels', () => {
    expect(gateBrowserUseRequest('click', 'A', 'A', true)).toBeNull()
    expect(gateBrowserUseRequest('snapshot', 'A', null, true)).toBeNull()
  })
})

describe('parseBrowserUseRequest', () => {
  it('accepts a valid navigate', () => {
    expect(parseBrowserUseRequest({ action: 'navigate', url: 'https://example.com' })).toEqual({
      action: 'navigate',
      url: 'https://example.com'
    })
  })

  it('rejects navigate without a url', () => {
    expect(parseBrowserUseRequest({ action: 'navigate' })).toBeNull()
    expect(parseBrowserUseRequest({ action: 'navigate', url: '' })).toBeNull()
  })

  it('accepts snapshot, screenshot, back and forward without params', () => {
    expect(parseBrowserUseRequest({ action: 'snapshot' })).toEqual({ action: 'snapshot' })
    expect(parseBrowserUseRequest({ action: 'screenshot' })).toEqual({ action: 'screenshot' })
    expect(parseBrowserUseRequest({ action: 'back' })).toEqual({ action: 'back' })
    expect(parseBrowserUseRequest({ action: 'forward' })).toEqual({ action: 'forward' })
  })

  it('accepts click with a bounded integer ref', () => {
    expect(parseBrowserUseRequest({ action: 'click', ref: 3 })).toEqual({ action: 'click', ref: 3 })
    expect(parseBrowserUseRequest({ action: 'click', ref: 0 })).toBeNull()
    expect(parseBrowserUseRequest({ action: 'click', ref: 2.5 })).toBeNull()
    expect(parseBrowserUseRequest({ action: 'click', ref: '3' })).toBeNull()
  })

  it('accepts type with ref and text, submit optional', () => {
    expect(parseBrowserUseRequest({ action: 'type', ref: 2, text: 'hello' })).toEqual({
      action: 'type',
      ref: 2,
      text: 'hello',
      submit: false
    })
    expect(parseBrowserUseRequest({ action: 'type', ref: 2, text: 'hi', submit: true })).toEqual({
      action: 'type',
      ref: 2,
      text: 'hi',
      submit: true
    })
    expect(parseBrowserUseRequest({ action: 'type', ref: 2 })).toBeNull()
  })

  it('clamps scroll amount and direction', () => {
    expect(parseBrowserUseRequest({ action: 'scroll', direction: 'down' })).toEqual({
      action: 'scroll',
      direction: 'down',
      amount: 600
    })
    expect(
      parseBrowserUseRequest({ action: 'scroll', direction: 'down', amount: 99999 })
    ).toEqual({ action: 'scroll', direction: 'down', amount: 4000 })
    expect(parseBrowserUseRequest({ action: 'scroll', direction: 'sideways' })).toBeNull()
  })

  it('clamps wait milliseconds', () => {
    expect(parseBrowserUseRequest({ action: 'wait', ms: 300 })).toEqual({ action: 'wait', ms: 300 })
    expect(parseBrowserUseRequest({ action: 'wait', ms: 999999 })).toEqual({
      action: 'wait',
      ms: 5000
    })
    expect(parseBrowserUseRequest({ action: 'wait' })).toEqual({ action: 'wait', ms: 1000 })
  })

  it('rejects unknown actions and non-object bodies', () => {
    expect(parseBrowserUseRequest({ action: 'eval', code: 'process.exit()' })).toBeNull()
    expect(parseBrowserUseRequest('navigate')).toBeNull()
    expect(parseBrowserUseRequest(null)).toBeNull()
  })
})
