import { describe, expect, it } from 'vitest'
import { resolveEnvProxyRules } from './envProxy'

const TIKTOK = 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer'
const direct = { mode: 'direct' }
const system = { mode: 'system' }
const fixed = (proxyRules: string) => ({ mode: 'fixed_servers', proxyRules })

describe('resolveEnvProxyRules', () => {
  it('uses system settings when no valid proxy is configured', () => {
    expect(resolveEnvProxyRules(TIKTOK, {})).toEqual(system)
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'not-a-proxy' })).toEqual(system)
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'http://user:password@proxy:8080' })).toEqual(system)
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'proxy:65536' })).toEqual(system)
  })

  it('preserves HTTPS and SOCKS proxy transport while accepting HTTP proxy rules', () => {
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'http://127.0.0.1:7897' })).toEqual(fixed('127.0.0.1:7897'))
    expect(resolveEnvProxyRules(TIKTOK, { https_proxy: 'https://proxy.lan:443/' })).toEqual(fixed('https://proxy.lan:443'))
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'socks5://127.0.0.1:1080' })).toEqual(fixed('socks5://127.0.0.1:1080'))
    expect(resolveEnvProxyRules(TIKTOK, { HTTP_PROXY: 'http://127.0.0.1:7897' })).toEqual(fixed('127.0.0.1:7897'))
  })

  it('treats explicit NO_PROXY as direct, even when a system proxy exists', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7897' }
    expect(resolveEnvProxyRules(TIKTOK, { ...env, NO_PROXY: '*' })).toEqual(direct)
    expect(resolveEnvProxyRules(TIKTOK, { ...env, NO_PROXY: 'business-api.tiktok.com' })).toEqual(direct)
    expect(resolveEnvProxyRules(TIKTOK, { ...env, NO_PROXY: '.tiktok.com' })).toEqual(direct)
    expect(resolveEnvProxyRules(TIKTOK, { ...env, NO_PROXY: 'localhost,127.0.0.1,::1' })).toEqual(fixed('127.0.0.1:7897'))
    expect(resolveEnvProxyRules(TIKTOK, { ...env, NO_PROXY: 'tiktok.com.evil.example' })).toEqual(fixed('127.0.0.1:7897'))
  })

  it('matches a NO_PROXY port only to that target port', () => {
    const env = { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'business-api.tiktok.com:444' }
    expect(resolveEnvProxyRules(TIKTOK, env)).toEqual(fixed('proxy:8080'))
    expect(resolveEnvProxyRules('https://business-api.tiktok.com:444/path', env)).toEqual(direct)
    expect(resolveEnvProxyRules('https://[::1]:444/', { ...env, NO_PROXY: '[::1]:444' })).toEqual(direct)
  })
})
