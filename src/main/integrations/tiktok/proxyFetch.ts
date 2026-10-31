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
    return ses.fetch(url, init) as unknown as Promise<Response>
  }
}

/** TikTok-facing calls, resolved afresh for each actual target. */
export async function proxySessionFetch(): Promise<ProxyAwareFetch> {
  return (url, init) => proxyFetchFor(url, 'tiktok-api').then((fetch) => fetch(url, init))
}
