import { proxyFetchFor } from './integrations/tiktok/proxyFetch'

// GitHub's public homepage explicitly declares this PNG as its alternate favicon.
const GITHUB_ICON_URL = 'https://github.githubassets.com/favicons/favicon.png'
const MAX_BYTES = 256 * 1024
const TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon'])
const PUBLIC_SITE_FALLBACKS: Readonly<Record<string, string>> = {
  'github.com': GITHUB_ICON_URL,
  'www.github.com': GITHUB_ICON_URL
}

/** Only an exact official asset constant may use the proxy-aware native network path. */
export function publicIconFallbackUrl(hostname: string): string | null {
  return Object.hasOwn(PUBLIC_SITE_FALLBACKS, hostname) ? PUBLIC_SITE_FALLBACKS[hostname] : null
}

/** No source URL or caller-provided hostname enters the fixed asset request. */
export async function requestPublicIconFallback(hostname: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string } | null> {
  const url = publicIconFallbackUrl(hostname)
  if (!url || signal.aborted) return null
  // The partition is non-persistent and separate from every browsing / advertising session.
  // Existing proxy parsing accepts system or credential-free configured proxies only.
  const fetch = await proxyFetchFor(url, 'site-icons-public-assets')
  if (signal.aborted) return null
  const init = {
    method: 'GET', signal, credentials: 'omit' as const, redirect: 'error' as const,
    cache: 'no-store' as const, referrerPolicy: 'no-referrer' as const,
    bypassCustomProtocolHandlers: true,
    headers: { Accept: 'image/png, image/x-icon, image/vnd.microsoft.icon', 'Accept-Encoding': 'identity' }
  }
  const response = await fetch(url, init)
  const mime = response.headers.get('content-type') ?? ''
  const encoding = response.headers.get('content-encoding')
  const declared = response.headers.get('content-length')
  if (response.status !== 200 || !TYPES.has(mime.split(';', 1)[0].trim().toLowerCase()) ||
      (encoding && encoding.toLowerCase() !== 'identity') ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) || !response.body) {
    void response.body?.cancel().catch(() => undefined)
    return null
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted || (size += value.byteLength) > MAX_BYTES) {
        void reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(Buffer.from(value))
    }
  } catch { return null }
  finally { reader.releaseLock() }
  return signal.aborted ? null : { bytes: Buffer.concat(chunks), mime }
}
