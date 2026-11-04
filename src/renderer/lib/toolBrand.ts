import type { ToolCallRecord } from './toolCalls'

export type ToolBrand = 'facebook' | 'tiktok' | 'feishu' | 'google' | 'figma' | 'appsflyer'
export interface WebsiteSource { url: string; hostname: string }

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
// Runtime results replace records; weak keys release parsed inputs with the transcript.
const actions = new WeakMap<ToolCallRecord, { name: string; input: Record<string, unknown> | null }>()
function parse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value)
  if (value.length > 64_000) return null
  try { return record(JSON.parse(value)) } catch { return null }
}

/** Only exact runtime proxy references name an action; paths and free text do not. */
function actionFor(call: ToolCallRecord): { name: string; input: Record<string, unknown> | null } {
  const cached = actions.get(call)
  if (cached) return cached
  let name = call.tool.toLowerCase()
  let input = parse(call.input)
  if ((name === 'read' || name === 'write') && typeof input?.path === 'string') {
    const proxy = /^xd:\/\/([a-z][a-z0-9_]{0,127})$/.exec(input.path)
    if (proxy) { name = proxy[1]; input = call.tool.toLowerCase() === 'write' ? parse(input.content) : null }
  }
  if (input?.url === undefined && typeof input?.content === 'string') input = parse(input.content)
  const action = { name, input }
  actions.set(call, action)
  return action
}

/** Syntax gate only. Main independently checks DNS, redirects and response bytes. */
function publicOrigin(value: unknown): WebsiteSource | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (hostname.length > 253 || !hostname.includes('.') || /[\[\]:]/.test(hostname) || /^[\d.]+$/.test(hostname)) return null
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(hostname)) return null
    if (/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|example|invalid|onion)$/.test(hostname)) return null
    return { url: `${url.protocol}//${hostname}/`, hostname }
  } catch { return null }
}

const WEB_TOOLS = new Set(['browser_navigate', 'browser_open', 'browser_report', 'web_fetch', 'fetch_url', 'open_url', 'toushou_browser_open', 'toushou_browser_navigate'])
const SEARCH_TOOLS = new Set(['web_search', 'search_web', 'browser_search'])

/** Explicit known URL fields only; never turn a query, command or arbitrary text into a hostname. */
export function websiteSourceForCall(call: ToolCallRecord): WebsiteSource | null {
  const { name, input } = actionFor(call)
  if (WEB_TOOLS.has(name) || SEARCH_TOOLS.has(name)) {
    const source = publicOrigin(input?.url)
    if (source) return source
  }
  return null
}

export function toolBrandForCall(call: ToolCallRecord): ToolBrand | null {
  const { name } = actionFor(call)
  if (/^(?:mcp__tiktok_ads_|toushou_tiktok_|touhou_tiktok_)/.test(name) || ['auth_advertiser_get', 'advertiser_info_get', 'report_integrated_get'].includes(name)) return 'tiktok'
  if (/^(?:mcp__appsflyer_|toushou_appsflyer_)/.test(name) || ['get_apps', 'analytics_fetch_aggregated_data'].includes(name)) return 'appsflyer'
  if (/^(?:mcp__feishu_|mcp__lark_|feishu_|lark_)/.test(name)) return 'feishu'
  if (/^(?:mcp__facebook_ads_|mcp__meta_ads_|toushou_facebook_|toushou_fb_|facebook_ads_|fb_)/.test(name)) return 'facebook'
  if (/^(?:mcp__google_ads_|mcp__googleads_|toushou_google_|google_ads_|googleads_)/.test(name)) return 'google'
  if (/^(?:mcp__figma_|figma_)/.test(name) || ['use_figma', 'get_design_context'].includes(name)) return 'figma'
  return null
}
