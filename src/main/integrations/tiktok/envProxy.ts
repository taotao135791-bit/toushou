/** Chromium proxy configuration derived from environment variables. */
export type EnvProxyConfig =
  | { mode: 'system' }
  | { mode: 'direct' }
  | { mode: 'fixed_servers'; proxyRules: string }

/** Explicit NO_PROXY bypass differs from an unset proxy, which uses the OS. */
export function resolveEnvProxyRules(targetUrl: string, env: NodeJS.ProcessEnv = process.env): EnvProxyConfig {
  let target: URL
  try { target = new URL(targetUrl) } catch { return { mode: 'system' } }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = target.port || (target.protocol === 'https:' ? '443' : target.protocol === 'http:' ? '80' : '')
  const noProxyRaw = (env.NO_PROXY ?? env.no_proxy ?? '').trim()
  for (const raw of noProxyRaw.split(',')) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return { mode: 'direct' }
    let entryPort = ''
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    if (bracketed) {
      entry = bracketed[1]
      entryPort = bracketed[2] ?? ''
    } else {
      const hostPort = /^([^:]+):(\d+)$/.exec(entry)
      if (hostPort) { entry = hostPort[1]; entryPort = hostPort[2] }
    }
    if (entryPort && entryPort !== port) continue
    entry = entry.replace(/^\*?\./, '')
    if (entry && (host === entry || host.endsWith(`.${entry}`))) return { mode: 'direct' }
  }

  const proxyRaw = ((target.protocol === 'https:' ? env.HTTPS_PROXY ?? env.https_proxy : undefined)
    ?? env.HTTP_PROXY ?? env.http_proxy ?? '').trim()
  if (!proxyRaw) return { mode: 'system' }
  // Chromium accepts a bare HTTP proxy and explicit HTTPS/SOCKS schemes.
  // Credentials and malformed authorities are not sent to setProxy.
  const proxy = proxyRaw.replace(/\/+$/, '')
  const match = /^(?:(http|https|socks4|socks5):\/\/)?(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d+)$/i.exec(proxy)
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return { mode: 'system' }
  const scheme = match[1]?.toLowerCase()
  const authority = `${match[2]}:${match[3]}`
  return { mode: 'fixed_servers', proxyRules: scheme && scheme !== 'http' ? `${scheme}://${authority}` : authority }
}
