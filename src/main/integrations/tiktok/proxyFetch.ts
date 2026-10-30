import { resolveEnvProxyRules } from './envProxy'

export type ProxyAwareFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Proxy-aware fetch for Main-initiated HTTP. The proxy decision is resolved
 * for the ACTUAL target URL, so NO_PROXY entries for one host (e.g. an
 * internal model relay) do not leak into another (e.g. TikTok's API).
 *
 * Sessions are created per partition and re-configured only when the resolved
 * config changes; concurrent calls are serialized through a small queue so a
 * setProxy never races a request that assumes the previous config.
 */
const states = new Map<string, { ses: Promise<import('electron').Session>; appliedKey: string | null; queue: Promise<unknown> }>()

export async function proxyFetchFor(targetUrl: string, partition: string): Promise<ProxyAwareFetch> {
  const config = resolveEnvProxyRules(targetUrl)
  const key = JSON.stringify(config)
  let state = states.get(partition)
  if (!state) {
    state = {
      ses: import('electron').then((m) => m.session.fromPartition(partition)),
      appliedKey: null,
      queue: Promise.resolve()
    }
    states.set(partition, state)
  }
  const current = state
  const ses = await current.ses
  current.queue = current.queue.then(async () => {
    if (current.appliedKey !== key) {
      await ses.setProxy(config)
      current.appliedKey = key
    }
  })
  await current.queue
  return (url, init) => ses.fetch(url, init) as unknown as Promise<Response>
}

/** TikTok-facing calls: one target, one dedicated session. */
export async function proxySessionFetch(): Promise<ProxyAwareFetch> {
  return proxyFetchFor('https://business-api.tiktok.com/', 'tiktok-api')
}
