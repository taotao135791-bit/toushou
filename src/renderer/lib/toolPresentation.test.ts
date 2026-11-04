import { describe, expect, it } from 'vitest'
import { presentToolCall } from './toolPresentation'
import { applyToolResult, type ToolCallRecord } from './toolCalls'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ToolCallCard from '../components/ToolCallCard'
import { useAppStore } from '../store'

const call = (tool: string, input: unknown = {}, output?: unknown, isError?: boolean): ToolCallRecord => ({ tool, input, output, isError })

describe('tool presentation', () => {
  it('renders recognized data sources with plain bilingual names and no raw arguments', () => {
    const secret = 'synthetic-private-token'
    expect(presentToolCall(call('toushou_appsflyer_query', { appId: secret }, { ok: true }), 'zh')).toEqual({ label: '查询 AppsFlyer 归因', summary: null, status: 'completed', statusLabel: '已完成' })
    expect(presentToolCall(call('toushou_tiktok_update', { advertiserId: secret }), 'en')).toEqual({ label: 'Update TikTok report', summary: null, status: 'running', statusLabel: 'In progress' })
    expect(JSON.stringify(presentToolCall(call('toushou_appsflyer_query', { authorization: secret }, { ok: false }), 'en'))).not.toContain(secret)
  })

  it('names exact native and normalized TikTok and AppsFlyer read tools without exposing IDs', () => {
    const cases = [
      ['mcp__tiktok_ads_report_integrated_get', '读取 TikTok 广告报表', 'Read TikTok ads report'],
      ['report_integrated_get', '读取 TikTok 广告报表', 'Read TikTok ads report'],
      ['mcp__tiktok_ads_auth_advertiser_get', '查看 TikTok 授权账户', 'View authorized TikTok accounts'],
      ['mcp__tiktok_ads_advertiser_info_get', '查看 TikTok 账户信息', 'View TikTok account information'],
      ['mcp__appsflyer_get_apps', '查看 AppsFlyer 应用', 'View AppsFlyer apps'],
      ['get_apps', '查看 AppsFlyer 应用', 'View AppsFlyer apps'],
      ['mcp__appsflyer_analytics_fetch_aggregated_data', '查询 AppsFlyer 归因', 'Query AppsFlyer attribution'],
      ['analytics_fetch_aggregated_data', '查询 AppsFlyer 归因', 'Query AppsFlyer attribution']
    ] as const
    for (const [name, zh, en] of cases) {
      const record = call(name, { advertiser_id: 'synthetic-private-id' }, 'response')
      expect(presentToolCall(record, 'zh').label).toBe(zh)
      expect(presentToolCall(record, 'en').label).toBe(en)
      expect(JSON.stringify(presentToolCall(record, 'zh'))).not.toContain('synthetic-private-id')
    }
    expect(presentToolCall(call('mcp__tiktok_ads_report_integrated_get_extra'), 'zh').label).toBe('工具调用')
    expect(presentToolCall(call('mcp__appsflyer_delete_something'), 'en').label).toBe('Tool call')
    expect(presentToolCall(call('read', { path: 'xd://toushou_board_get' }), 'zh').label).toBe('查看工具说明')
    expect(presentToolCall(call('read', { path: 'xd://toushou_board_get/extra' }), 'zh').label).toBe('读取文件')
  })

  it('recognizes exact xd paths and unwraps content for a safe known type', () => {
    const wrapped = call('write', JSON.stringify({ path: 'xd://toushou_board_add_widget', content: JSON.stringify({ type: 'reading-module', boardId: 'private-id' }) }), { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] })
    expect(presentToolCall(wrapped, 'zh')).toEqual({ label: '添加看板组件', summary: '读数模块', status: 'completed', statusLabel: '已完成' })
    expect(presentToolCall(call('toushou_board_add_widget', { content: '{"type":"file"}' }), 'zh').summary).toBe('文件')
    const other = call('write', { path: 'xd://toushou_board_add_widget/extra', content: JSON.stringify({ type: 'file' }) }, { ok: true })
    expect(presentToolCall(other, 'en')).toMatchObject({ label: 'Tool call', summary: null })
    expect(presentToolCall(call('toushou_board_add_widget', { type: 'unknown-private-name' }), 'en').summary).toBeNull()
  })

  it('renders a collapsed, accessible status without exposing raw names or parameters', () => {
    useAppStore.setState({ language: 'en' })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolCall: call('toushou_appsflyer_query', { appId: 'synthetic-private-id' }, { ok: true }) }))
    expect(html).toContain('Query AppsFlyer attribution')
    expect(html).toContain('Completed')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('synthetic-private-id')
    expect(html).not.toContain('toushou_appsflyer_query')
  })

  it('reuses immutable call presentation per language and refreshes when the result arrives', () => {
    const pending = { id: 'synthetic-call', tool: 'toushou_appsflyer_query', input: {} }
    const zh = presentToolCall(pending, 'zh')
    expect(presentToolCall(pending, 'zh')).toBe(zh)
    const en = presentToolCall(pending, 'en')
    expect(en).not.toBe(zh)
    expect(en.statusLabel).toBe('In progress')
    expect(presentToolCall(pending, 'en')).toBe(en)
    const [updated] = applyToolResult([{ id: 'synthetic-message', role: 'assistant', content: '', toolCall: pending }], {
      type: 'tool_result', sessionId: 'synthetic-session', id: 'synthetic-call', tool: 'toushou_appsflyer_query', output: { ok: false }, isError: false
    })
    expect(updated.toolCall).not.toBe(pending)
    expect(presentToolCall(updated.toolCall!, 'zh')).toMatchObject({ status: 'failed', statusLabel: '失败' })
    expect(presentToolCall(pending, 'zh')).toBe(zh)
  })

  it('preserves explicit failures and does not infer success for unstructured results', () => {
    const failed = { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'synthetic' }) }] }
    expect(presentToolCall(call('toushou_board_create', {}, failed), 'zh')).toMatchObject({ status: 'failed', statusLabel: '失败' })
    expect(presentToolCall(call('toushou_board_create', {}, { isError: true }), 'en')).toMatchObject({ status: 'failed', statusLabel: 'Failed' })
    expect(presentToolCall(call('unknown_vendor_tool', { token: 'private' }, 'arbitrary text'), 'en')).toEqual({ label: 'Tool call', summary: null, status: 'finished', statusLabel: 'Finished' })
    expect(presentToolCall(call('unknown_vendor_tool', {}, { ok: true }), 'en').status).toBe('finished')
    expect(presentToolCall(call('unknown_vendor_tool', {}, undefined, true), 'zh').status).toBe('failed')
    expect(presentToolCall(call('toushou_board_create', {}, '{broken'), 'en').status).toBe('finished')
  })
})
