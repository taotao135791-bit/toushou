import { describe, expect, it } from 'vitest'
import { isSuspendedFacebookBrowserRequest, suspendedFacebookBrowserResult } from './legacyFacebookBrowser'
import registerBrowserTools from '../../resources/browser-use-toolkit/extensions/index'

describe('archived Facebook browser route', () => {
  it('rejects stale report calls and Ads Manager navigation and inspection', () => {
    expect(isSuspendedFacebookBrowserRequest('report')).toBe(true)
    for (const url of ['https://adsmanager.facebook.com/adsmanager/manage/campaigns', 'https://business.facebook.com/latest', 'https://www.facebook.com/adsmanager/manage']) {
      expect(isSuspendedFacebookBrowserRequest('navigate', url)).toBe(true)
      for (const action of ['snapshot', 'click', 'screenshot', 'back', 'scroll']) expect(isSuspendedFacebookBrowserRequest(action, undefined, url)).toBe(true)
    }
    expect(suspendedFacebookBrowserResult()).toMatchObject({ ok: false, error: 'legacy-facebook-browser-suspended' })
  })

  it('keeps unrelated browsing and saved history available', () => {
    expect(isSuspendedFacebookBrowserRequest('navigate', 'https://example.com', 'https://adsmanager.facebook.com')).toBe(false)
    expect(isSuspendedFacebookBrowserRequest('snapshot', undefined, 'https://example.com')).toBe(false)
    expect(isSuspendedFacebookBrowserRequest('navigate', 'https://www.facebook.com/dialog/oauth')).toBe(false)
    expect(isSuspendedFacebookBrowserRequest('history', undefined, 'https://adsmanager.facebook.com')).toBe(false)
  })

  it('does not advertise legacy readers to the model while retaining general browser tools', () => {
    const names: string[] = []
    registerBrowserTools({ registerTool: tool => { names.push(tool.name) } })
    expect(names).not.toContain('browser_report')
    expect(names).not.toContain('fb_history')
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_snapshot')
  })
})
