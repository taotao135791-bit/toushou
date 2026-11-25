import { describe, expect, it } from 'vitest'
import { presentToolCall } from './toolPresentation'
import { toolBrandForCall } from './toolBrand'
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

  it.each([
    ['toushou_dingtalk_create_document', '创建钉钉文档', 'Create DingTalk document'],
    ['toushou_dingtalk_append_document', '向钉钉文档追加正文', 'Append to DingTalk document'],
    ['toushou_dingtalk_workspace_catalog', '查看钉钉可用操作', 'Browse DingTalk actions'],
    ['toushou_dingtalk_workspace_read', '读取钉钉工作区数据', 'Read DingTalk workspace data'],
    ['toushou_dingtalk_workspace_write', '写入钉钉工作区数据', 'Update DingTalk workspace data']
  ])('shows %s as a DingTalk action without including document content in the header', (tool, zh, en) => {
    const input = { markdown: 'synthetic draft text' }
    const direct = call(tool, input, { ok: true })
    const proxy = call('write', { path: `xd://${tool}`, content: JSON.stringify(input) }, { ok: false })
    const mounted = call('bash', { command: `${tool} --json '${JSON.stringify(input)}'` }, { ok: true })
    for (const record of [direct, proxy, mounted]) {
      expect(toolBrandForCall(record)).toBe('dingtalk')
      expect(presentToolCall(record, 'zh')).toMatchObject({ label: zh, summary: null })
      expect(presentToolCall(record, 'en')).toMatchObject({ label: en, summary: null })
    }
    expect(presentToolCall(direct, 'zh').status).toBe('completed')
    expect(presentToolCall(proxy, 'en').status).toBe('failed')
  })

  it('keeps compound shell commands and unrelated mentions unbranded', () => {
    const name = 'toushou_dingtalk_workspace_read'
    for (const command of [
      `echo ${name}`, `${name} --help`, `${name} --operation x && echo end`,
      `${name} | cat`, `${name} --args "$HOME"`, `${name}\nother`, `${name}_other --id sample`
    ]) {
      const record = call('bash', { command })
      expect(toolBrandForCall(record)).toBeNull()
      expect(presentToolCall(record, 'en').label).toBe('Run command')
    }
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
