import { createHash } from 'node:crypto'
import { session } from 'electron'
import { resolveEnvProxyRules } from './envProxy'

export type ProxyAwareFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Sessions are in-memory and immutable per resolved proxy config. */
const sessions = new Map<string, Promise<import('electron').Session>>()

export async function proxyFetchFor(targetUrl: string, partition: string): Promise<ProxyAwareFetch> {
  const config = resolveEnvProxyRules(targetUrl)
  const key = JSON.stringify([partition, config])
  let pending = sessions.get(key)
  if (!pending) {
    const hash = createHash('sha256').update(key).digest('hex')
    const created = Promise.resolve().then(async () => {
      const ses = session.fromPartition(`proxy-${hash}`)
      await ses.setProxy(config)
      return ses
    })
    pending = created.catch((error) => {
      if (sessions.get(key) === pending) sessions.delete(key)
      throw error
    })
    sessions.set(key, pending)
  }
  const ses = await pending
  return async (url, init) => {
    // Never let a caller accidentally use the configuration for another URL.
    if (JSON.stringify([partition, resolveEnvProxyRules(url)]) !== key) {
      return (await proxyFetchFor(url, partition))(url, init)
    }
    try {
      return await (ses.fetch(url, init) as unknown as Promise<Response>)
    } catch (error) {
      // A fixed_servers session lacks the fallback chain a browser gets from
      // a PAC ("PROXY …; SOCKS5 …; DIRECT"): when the configured proxy cannot
      // complete the TLS handshake to one origin, a browser silently falls
      // back to DIRECT while we would just fail. Mirror that behavior for
      // environment-proxied sessions only — 'system' already carries the
      // OS fallback, and 'direct' has nothing to fall back from.
      if (config.mode !== 'fixed_servers') throw error
      const retry = new Error('proxy-fetch-failed')
      ;(retry as NodeJS.ErrnoException & { cause?: unknown }).cause = error
      const directSession = await (async () => {
        const directKey = JSON.stringify([partition, { mode: 'direct' }])
        let directPending = sessions.get(directKey)
        if (!directPending) {
          directPending = Promise.resolve().then(async () => {
            const s = session.fromPartition(`proxy-${createHash('sha256').update(directKey).digest('hex')}`)
            await s.setProxy({ mode: 'direct' })
            return s
          })
          sessions.set(directKey, directPending)
        }
        return directPending
      })()
      try {
        return await (directSession.fetch(url, init) as unknown as Promise<Response>)
      } catch (directError) {
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
