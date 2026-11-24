import { createHash } from 'node:crypto'
import { session, type ProxyConfig } from 'electron'
import { resolveEnvProxyRules } from './envProxy'

export type ProxyAwareFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Per-channel routing policy (用户拍板：媒体数据与 AF 分层路由):
 * - 'single-route' — TikTok uses the configured route or the system's first
 *   route. A failed request does not switch to another route.
 * - 'direct-only' — AppsFlyer's CloudFront edge breaks TLS handshakes on the
 *   common CN proxy nodes while direct reaches it everywhere (2026-11-04
 *   实测：代理 0/5、直连 5/5). Never touch the proxy — this also removes the
 *   per-call dead-handshake tax the generic fallback used to pay.
 * - 'fallback'    — the historic generic behavior: proxy first, one direct
 *   retry on failure (mirrors a browser's PAC fallback chain).
 */
type ChannelPolicy = 'single-route' | 'direct-only' | 'fallback'

const CHANNEL_POLICIES: Record<string, ChannelPolicy> = {
  'tiktok-api': 'single-route',
  // AF 的两个分区名：数据集客户端用 appsflyer-api，连接管理器（OAuth/探活）用 appsflyer。
  'appsflyer-api': 'direct-only',
  appsflyer: 'direct-only'
}

const policyFor = (partition: string): ChannelPolicy => CHANNEL_POLICIES[partition] ?? 'fallback'

/** Sessions are in-memory and immutable per resolved proxy config. */
const sessions = new Map<string, Promise<import('electron').Session>>()

async function sessionFor(key: string, config: ProxyConfig): Promise<import('electron').Session> {
  let pending = sessions.get(key)
  if (!pending) {
    const created = Promise.resolve().then(async () => {
      const ses = session.fromPartition(`proxy-${createHash('sha256').update(key).digest('hex')}`)
      await ses.setProxy(config)
      return ses
    })
    pending = created.catch((error) => {
      if (sessions.get(key) === pending) sessions.delete(key)
      throw error
    })
    sessions.set(key, pending)
  }
  return pending
}

async function tikTokProxyConfig(targetUrl: string): Promise<ProxyConfig> {
  const configured = resolveEnvProxyRules(targetUrl)
  if (configured.mode === 'fixed_servers') return { ...configured, proxyBypassRules: '<-loopback>' }
  if (configured.mode === 'direct') return configured
  let route: string
  try {
    const system = await sessionFor(JSON.stringify(['tiktok-api', configured]), configured)
    route = await system.resolveProxy(targetUrl)
  } catch (cause) {
    throw new Error('tiktok-route-unavailable', { cause })
  }
  // DIRECT is a valid primary route. OS-level VPNs can still carry the traffic.
  const first = route.split(';', 1)[0].trim()
  if (first.toUpperCase() === 'DIRECT') return { mode: 'direct' }
  const proxy = /^(PROXY|HTTPS|SOCKS4?|SOCKS5)\s+(\[[a-f0-9:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(first)
  if (proxy && Number(proxy[3]) > 0 && Number(proxy[3]) <= 65535) {
    const kind = proxy[1].toLowerCase()
    const scheme = kind === 'proxy' ? 'http' : kind === 'socks' ? 'socks4' : kind
    return { mode: 'fixed_servers', proxyRules: `${scheme}://${proxy[2]}:${proxy[3]}`, proxyBypassRules: '<-loopback>' }
  }
  throw new Error('tiktok-route-unavailable')
}

export async function proxyFetchFor(targetUrl: string, partition: string): Promise<ProxyAwareFetch> {
  const policy = policyFor(partition)
  if (policy === 'single-route') {
    const config = await tikTokProxyConfig(targetUrl)
    const ses = await sessionFor(JSON.stringify([partition, config]), config)
    return async (url, init) => url === targetUrl
      ? (ses.fetch(url, init) as unknown as Promise<Response>)
      : (await proxyFetchFor(url, partition))(url, init)
  }
  // direct-only ignores whatever the environment says for this origin.
  const config = policy === 'direct-only' ? ({ mode: 'direct' } as const) : resolveEnvProxyRules(targetUrl)
  const key = JSON.stringify([partition, config])
  const ses = await sessionFor(key, config)
  return async (url, init) => {
    // Never let a caller accidentally use the configuration for another URL.
    const urlPolicy = policyFor(partition)
    const urlConfig = urlPolicy === 'direct-only' ? ({ mode: 'direct' } as const) : resolveEnvProxyRules(url)
    if (JSON.stringify([partition, urlConfig]) !== key) {
      return (await proxyFetchFor(url, partition))(url, init)
    }
    try {
      return await (ses.fetch(url, init) as unknown as Promise<Response>)
    } catch (error) {
      if (policy !== 'fallback') throw error
      // A fixed_servers session lacks the fallback chain a browser gets from
      // a PAC ("PROXY …; SOCKS5 …; DIRECT"): when the configured proxy cannot
      // complete the TLS handshake to one origin, a browser silently falls
      // back to DIRECT while we would just fail. Mirror that behavior for
      // environment-proxied sessions only — 'system' already carries the
      // OS fallback, and 'direct' has nothing to fall back from.
      if (config.mode !== 'fixed_servers') throw error
      const retry = new Error('proxy-fetch-failed')
      ;(retry as NodeJS.ErrnoException & { cause?: unknown }).cause = error
      try {
        const directSession = await sessionFor(JSON.stringify([partition, { mode: 'direct' }]), { mode: 'direct' })
        return await (directSession.fetch(url, init) as unknown as Promise<Response>)
      } catch {
        // Direct also failed: the original proxy error is the honest one.
        throw retry
      }
    }
  }
}

/** TikTok-facing calls, resolved afresh for each actual target. */
export async function proxySessionFetch(): Promise<ProxyAwareFetch> {
  return (url, init) => proxyFetchFor(url, 'tiktok-api').then((fetch) => fetch(url, init))
}
