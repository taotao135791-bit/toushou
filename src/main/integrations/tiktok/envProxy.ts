// 环境代理解析（纯函数，可单测）。
// 背景：主进程内嵌 Node 20 的 fetch 不认 NODE_USE_ENV_PROXY（Node 24 才有），
// 国内不挂代理直连不到 business-api.tiktok.com。这里从标准代理环境变量推出
// Chromium 的 proxyRules，供专用 Electron 会话走系统级代理发请求。
export function resolveEnvProxyRules(targetUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const noProxyRaw = (env.NO_PROXY ?? env.no_proxy ?? '').trim()
  if (noProxyRaw) {
    let host: string
    try {
      host = new URL(targetUrl).hostname
    } catch {
      host = ''
    }
    for (const rawEntry of noProxyRaw.split(',')) {
      const entry = rawEntry.trim().toLowerCase()
      if (!entry) continue
      if (entry === '*') return null
      // NO_PROXY 条目可带端口（host:port）；只按主机名匹配，后缀需落在域边界上。
      const entryHost = entry.replace(/:\d+$/, '')
      const matches = host === entryHost || (entryHost.startsWith('.') ? host.endsWith(entryHost) : host.endsWith(`.${entryHost}`))
      if (matches) return null
    }
  }
  const isHttps = targetUrl.startsWith('https:')
  const proxyRaw = ((isHttps ? env.HTTPS_PROXY ?? env.https_proxy : undefined) ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? '').trim()
  if (!proxyRaw) return null
  // http://host:port → host:port（Chromium 裸规则对所有协议生效）；socks5:// 前缀保留。
  const proxy = proxyRaw.replace(/\/+$/, '')
  const schemeMatch = /^([a-z0-9]+):\/\//i.exec(proxy)
  const hostPort = schemeMatch ? proxy.slice(schemeMatch[0].length) : proxy
  if (!/^[a-z0-9.-]+:\d+$/i.test(hostPort)) return null
  return schemeMatch && /^socks/i.test(schemeMatch[1]) ? `${schemeMatch[1]}://${hostPort}` : hostPort
}
