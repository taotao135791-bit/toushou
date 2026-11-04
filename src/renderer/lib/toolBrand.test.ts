import { describe, expect, it, vi } from 'vitest'
import { toolBrandForCall, websiteSourceForCall } from './toolBrand'

describe('tool brands', () => {
  it.each([
    ['mcp__tiktok_ads_report_integrated_get', 'tiktok'],
    ['toushou_tiktok_update', 'tiktok'],
    ['mcp__appsflyer_analytics_fetch_aggregated_data', 'appsflyer'],
    ['toushou_appsflyer_apps', 'appsflyer'],
    ['fb_history', 'facebook'],
    ['mcp__facebook_ads_get_insights', 'facebook'],
    ['feishu_docs', 'feishu'],
    ['mcp__google_ads_query', 'google'],
    ['mcp__figma_use_figma', 'figma'],
    ['use_figma', 'figma']
  ])('recognizes a known service namespace: %s', (tool, brand) => {
    expect(toolBrandForCall({ tool, input: {} })).toBe(brand)
  })

  it('recognizes an exact schema or write proxy but not a path suffix or arbitrary text', () => {
    expect(toolBrandForCall({ tool: 'read', input: { path: 'xd://toushou_appsflyer_query' } })).toBe('appsflyer')
    expect(toolBrandForCall({ tool: 'write', input: JSON.stringify({ path: 'xd://toushou_tiktok_update', content: '{}' }) })).toBe('tiktok')
    expect(toolBrandForCall({ tool: 'write', input: { path: 'xd://toushou_tiktok_update/other', content: '{}' } })).toBeNull()
    expect(toolBrandForCall({ tool: 'unknown', input: { query: 'facebook google tiktok' } })).toBeNull()
    expect(toolBrandForCall({ tool: 'unknown', input: {}, output: 'AppsFlyer connected' })).toBeNull()
  })
})

describe('explicit website source metadata', () => {
  it('parses an immutable input once across brand and website projections, and refreshes for a new record', () => {
    const call = { tool: 'browser_navigate', input: JSON.stringify({ url: 'https://github.com/' }) }
    const parse = vi.spyOn(JSON, 'parse')
    try {
      toolBrandForCall(call)
      expect(websiteSourceForCall(call)?.hostname).toBe('github.com')
      toolBrandForCall(call)
      websiteSourceForCall(call)
      expect(parse).toHaveBeenCalledTimes(1)
      expect(websiteSourceForCall({ ...call, input: '{"url":"https://www.figma.com/"}' })?.hostname).toBe('www.figma.com')
      expect(parse).toHaveBeenCalledTimes(2)
    } finally { parse.mockRestore() }
  })
  it('keeps only the public origin and hostname, dropping private URL context', () => {
    expect(websiteSourceForCall({ tool: 'browser_navigate', input: { url: 'https://Docs.Example.COM/report/123?token=synthetic#fragment' } }))
      .toEqual({ url: 'https://docs.example.com/', hostname: 'docs.example.com' })
  })

  it('supports the exact wrapper and already normalized content envelope', () => {
    const expected = { url: 'https://www.figma.com/', hostname: 'www.figma.com' }
    expect(websiteSourceForCall({ tool: 'write', input: { path: 'xd://browser_navigate', content: JSON.stringify({ url: 'https://www.figma.com/file/synthetic' }) } })).toEqual(expected)
    expect(websiteSourceForCall({ tool: 'browser_navigate', input: { content: JSON.stringify({ url: 'https://www.figma.com/file/synthetic' }) } })).toEqual(expected)
    expect(websiteSourceForCall({ tool: 'write', input: { path: 'xd://browser_navigate/other', content: JSON.stringify({ url: 'https://www.figma.com/' }) } })).toBeNull()
  })

  it('does not guess from queries, commands, unknown tools or tool output', () => {
    expect(websiteSourceForCall({ tool: 'web_search', input: { query: 'https://example.com/private-report' } })).toBeNull()
    expect(websiteSourceForCall({ tool: 'bash', input: { command: 'curl https://example.com' } })).toBeNull()
    expect(websiteSourceForCall({ tool: 'unknown', input: { url: 'https://example.com' } })).toBeNull()
    expect(websiteSourceForCall({ tool: 'web_search', input: {}, output: { results: [{ url: 'https://example.com' }] } })).toBeNull()
  })

  it.each([
    'https://synthetic:secret@example.com/', 'http://localhost/', 'https://service.local/',
    'http://127.1/', 'https://0x7f000001/', 'https://[::1]/', 'https://office.internal/',
    'file:///private/synthetic', 'data:text/html,example.com', 'javascript:alert(1)',
    'https://example.com:8443/', 'https://example.com:80/', 'https://example.com/\nsecret',
    '//example.com/', 'example.com'
  ])('rejects unsafe or non-explicit website input: %s', url => {
    expect(websiteSourceForCall({ tool: 'browser_navigate', input: { url } })).toBeNull()
  })
})
