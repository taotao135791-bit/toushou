import { describe, expect, it } from 'vitest'
import { resolveEnvProxyRules } from './envProxy'

const TIKTOK = 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer'

describe('resolveEnvProxyRules', () => {
  it('returns null with no proxy env', () => {
    expect(resolveEnvProxyRules(TIKTOK, {})).toBeNull()
  })

  it('derives bare host:port rules from HTTPS_PROXY', () => {
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'http://127.0.0.1:7897' })).toBe('127.0.0.1:7897')
    expect(resolveEnvProxyRules(TIKTOK, { https_proxy: 'http://proxy.lan:8080/' })).toBe('proxy.lan:8080')
  })

  it('keeps socks schemes and rejects malformed values', () => {
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'socks5://127.0.0.1:1080' })).toBe('socks5://127.0.0.1:1080')
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'not-a-proxy' })).toBeNull()
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: '127.0.0.1' })).toBeNull()
  })

  it('falls back to HTTP_PROXY when only that is set', () => {
    expect(resolveEnvProxyRules(TIKTOK, { HTTP_PROXY: 'http://127.0.0.1:7897' })).toBe('127.0.0.1:7897')
  })

  it('honors NO_PROXY wildcards and host entries', () => {
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: '*' })).toBeNull()
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'business-api.tiktok.com' })).toBeNull()
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1,::1' })).toBe('127.0.0.1:7897')
    // Suffix matching must stay on domain boundaries.
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'tiktok.com.evil.example' })).toBe('127.0.0.1:7897')
    expect(resolveEnvProxyRules(TIKTOK, { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: '.tiktok.com' })).toBeNull()
  })
})
