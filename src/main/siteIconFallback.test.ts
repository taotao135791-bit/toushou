import { afterEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ fetch: vi.fn(), factory: vi.fn() }))
vi.mock('./integrations/tiktok/proxyFetch', () => ({ proxyFetchFor: transport.factory }))
import { publicIconFallbackUrl, requestPublicIconFallback } from './siteIconFallback'

afterEach(() => { vi.clearAllMocks() })

describe('fixed public favicon fallback', () => {
  it('allows only an exact fixed public site in the fixed provider path', () => {
    expect(publicIconFallbackUrl('github.com')).toBe('https://github.githubassets.com/favicons/favicon.png')
    expect(publicIconFallbackUrl('www.github.com')).toBe('https://github.githubassets.com/favicons/favicon.png')
    for (const value of ['customer.github.com', 'github.io', 'private-customer.com', 'https://github.com/path?secret=x', 'github.com/../other', 'user@github.com', 'github.com:443', '127.0.0.1', 'localhost', 'office.internal', 'service.local', 'example.com', 'a.example.org', 'name.test', '__proto__']) expect(publicIconFallbackUrl(value), value).toBeNull()
  })
  it('uses an isolated native transport with omitted credentials, no referrer and no redirects', async () => {
    transport.factory.mockResolvedValue(transport.fetch)
    transport.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    const signal = new AbortController().signal
    const result = await requestPublicIconFallback('github.com', signal)
    expect(result).toEqual({ bytes: Buffer.from([1, 2, 3]), mime: 'image/png' })
    expect(transport.factory).toHaveBeenCalledWith('https://github.githubassets.com/favicons/favicon.png', 'site-icons-public-assets')
    const [url, init] = transport.fetch.mock.calls[0]
    expect(url).toBe('https://github.githubassets.com/favicons/favicon.png')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', bypassCustomProtocolHandlers: true, signal })
    expect(init.headers).toEqual({ Accept: 'image/png, image/x-icon, image/vnd.microsoft.icon', 'Accept-Encoding': 'identity' })
  })
  it('rejects redirects, remote markup, compressed and oversized bodies', async () => {
    transport.factory.mockResolvedValue(transport.fetch)
    const signal = new AbortController().signal
    for (const response of [
      new Response(null, { status: 302, headers: { location: 'https://private.local/' } }),
      new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } }),
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png', 'content-length': '262145' } }),
      new Response(new Uint8Array(262145), { headers: { 'content-type': 'image/png' } })
    ]) {
      transport.fetch.mockResolvedValueOnce(response)
      expect(await requestPublicIconFallback('github.com', signal)).toBeNull()
    }
  })
  it('does not start network work for aborted or invalid inputs', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await requestPublicIconFallback('github.com', controller.signal)).toBeNull()
    expect(await requestPublicIconFallback('private.local', new AbortController().signal)).toBeNull()
    expect(await requestPublicIconFallback('customer.github.com', new AbortController().signal)).toBeNull()
    expect(await requestPublicIconFallback('private-customer.com', new AbortController().signal)).toBeNull()
    expect(transport.factory).not.toHaveBeenCalled()
  })
})
