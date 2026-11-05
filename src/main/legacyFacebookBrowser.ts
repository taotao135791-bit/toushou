/** Archived browser readers stay in source; public entry points fail before navigation. */
export function suspendedFacebookBrowserResult() {
  return { ok: false as const, error: 'legacy-facebook-browser-suspended', fetchError: 'fetch-failed' as const, detail: '旧 Facebook 网页读数已暂停，请使用「连接 → Meta Ads」；已有报表和历史数据仍保留。' }
}

export function isSuspendedFacebookBrowserRequest(action: string, targetUrl?: string, currentUrl?: string): boolean {
  if (action === 'report') return true
  // Local history is retained; it neither opens a page nor reads new data.
  if (action === 'history') return false
  const url = action === 'navigate' ? targetUrl : currentUrl
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'adsmanager.facebook.com' || parsed.hostname === 'business.facebook.com' ||
      ((parsed.hostname === 'facebook.com' || parsed.hostname === 'www.facebook.com') && parsed.pathname.startsWith('/adsmanager'))
  } catch { return false }
}
