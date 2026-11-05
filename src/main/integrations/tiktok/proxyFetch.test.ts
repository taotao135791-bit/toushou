import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  sessions: new Map<string, { setProxy: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> }>(),
  failNext: false
}))
vi.mock('electron', () => ({ session: { fromPartition: (name: string) => {
  let ses = fixture.sessions.get(name)
  if (!ses) {
    ses = {
      setProxy: vi.fn(async () => { if (fixture.failNext) { fixture.failNext = false; throw new Error('synthetic failure') } }),
      fetch: vi.fn(async () => new Response('ok'))
    }
    fixture.sessions.set(name, ses)
  }
  return ses
} } }))

import { proxyFetchFor, proxySessionFetch } from './proxyFetch'

beforeEach(() => {
  fixture.sessions.clear()
  fixture.failNext = false
  vi.stubEnv('HTTPS_PROXY', 'http://proxy.invalid:8080')
  vi.stubEnv('HTTP_PROXY', '')
  vi.stubEnv('http_proxy', '')
  vi.stubEnv('NO_PROXY', 'direct.invalid')
})
afterEach(() => vi.unstubAllEnvs())

describe('proxyFetchFor', () => {
  it('isolates simultaneous direct, system and fixed configurations', async () => {
    await import('electron') // Vitest must finish loading its mocked module before concurrent dynamic imports.
    const partition = 'test-concurrent'
    const request = async (url: string) => (await proxyFetchFor(url, partition))(url)
    await Promise.all([
      request('https://direct.invalid/'),
      request('http://system.invalid/'),
      request('https://remote.invalid/'),
      request('https://remote.invalid/second')
    ])
    const all = [...fixture.sessions.values()]
    expect(all).toHaveLength(3)
    expect(all.map((s) => s.setProxy.mock.calls[0][0])).toEqual(expect.arrayContaining([
      { mode: 'direct' }, { mode: 'system' }, { mode: 'fixed_servers', proxyRules: 'proxy.invalid:8080' }
    ]))
    expect(all.map((s) => s.fetch.mock.calls.length).sort()).toEqual([1, 1, 2])
  })

  it('routes the actual URL rather than reusing a different target config', async () => {
    const fetch = await proxyFetchFor('https://remote.invalid/', 'test-retarget')
    await fetch('https://direct.invalid/')
    const sessions = [...fixture.sessions.values()]
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.setProxy.mock.calls[0][0].mode === 'direct')?.fetch).toHaveBeenCalledTimes(1)
  })

  it('retries proxy setup after a failure', async () => {
    fixture.failNext = true
    await expect(proxyFetchFor('https://remote.invalid/', 'test-retry')).rejects.toThrow('synthetic failure')
    const fetch = await proxyFetchFor('https://remote.invalid/', 'test-retry')
    await fetch('https://remote.invalid/')
    const [ses] = [...fixture.sessions.values()]
    expect(ses.setProxy).toHaveBeenCalledTimes(2)
    expect(ses.fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves TikTok transport against each actual URL', async () => {
    const fetch = await proxySessionFetch()
    await fetch('https://direct.invalid/')
    expect([...fixture.sessions.values()][0].setProxy).toHaveBeenCalledWith({ mode: 'direct' })
  })

  it('falls back to direct when the fixed proxy fetch throws, mirroring a PAC fallback chain', async () => {
    const proxied = await proxyFetchFor('https://remote.invalid/', 'test-fallback')
    const proxySession = [...fixture.sessions.values()].find((s) => s.setProxy.mock.calls[0][0].mode === 'fixed_servers')!
    proxySession.fetch.mockImplementationOnce(async () => { throw new Error('ECONNRESET') })
    const response = await proxied('https://remote.invalid/')
    expect(await response.text()).toBe('ok')
    const directSession = [...fixture.sessions.values()].find((s) => s.setProxy.mock.calls[0][0].mode === 'direct')
    expect(directSession?.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not fall back for direct or system sessions', async () => {
    const direct = await proxyFetchFor('https://direct.invalid/', 'test-nofallback-direct')
    const directSession = [...fixture.sessions.values()].find((s) => s.setProxy.mock.calls[0][0].mode === 'direct')!
    directSession.fetch.mockImplementationOnce(async () => { throw new Error('ECONNRESET') })
    await expect(direct('https://direct.invalid/')).rejects.toThrow('ECONNRESET')

    const system = await proxyFetchFor('http://system.invalid/', 'test-nofallback-system')
    const systemSession = [...fixture.sessions.values()].find((s) => s.setProxy.mock.calls[0][0].mode === 'system')!
    systemSession.fetch.mockImplementationOnce(async () => { throw new Error('ECONNRESET') })
    await expect(system('http://system.invalid/')).rejects.toThrow('ECONNRESET')
  })

  it('reports the proxy error when direct also fails', async () => {
    const proxied = await proxyFetchFor('https://remote.invalid/', 'test-fallback-both')
    const proxySession = [...fixture.sessions.values()].find((s) => s.setProxy.mock.calls[0][0].mode === 'fixed_servers')!
    proxySession.fetch.mockImplementation(async () => { throw new Error('ECONNRESET') })
    // Prime the direct session through a real call so it exists before the
    // fallback path grabs it.
    try { await proxied('https://remote.invalid/') } catch { /* both fail */ }
    const directSession = [...fixture.sessions.values()].find((s) => s.setProxy.mock.calls[0][0].mode === 'direct')!
    directSession.fetch.mockImplementation(async () => { throw new Error('ECONNRESET') })
    await expect(proxied('https://remote.invalid/')).rejects.toThrow('proxy-fetch-failed')
  })
})
