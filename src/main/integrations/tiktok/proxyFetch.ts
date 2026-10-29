import { resolveEnvProxyRules } from './envProxy'

/**
 * Shared proxy-aware fetch for TikTok-facing HTTP from Main: explicit
 * HTTPS_PROXY/HTTP_PROXY/NO_PROXY env vars win, otherwise the OS proxy
 * settings, never a forced direct connection. Node 20's fetch ignores
 * NODE_USE_ENV_PROXY, so everything that dials TikTok goes through here.
 */
let cache: { rules: string | null; promise: Promise<(url: string, init?: RequestInit) => Promise<Response>> } | null = null

export async function proxySessionFetch(): Promise<(url: string, init?: RequestInit) => Promise<Response>> {
  const rules = resolveEnvProxyRules('https://business-api.tiktok.com/')
  if (!cache || cache.rules !== rules) {
    cache = {
      rules,
      promise: (async () => {
        const { session } = await import('electron')
        const ses = session.fromPartition('tiktok-api')
        await ses.setProxy(rules ? { proxyRules: rules } : { mode: 'system' })
        return (url: string, init?: RequestInit) => ses.fetch(url, init) as unknown as Promise<Response>
      })()
    }
  }
  return cache.promise
}
