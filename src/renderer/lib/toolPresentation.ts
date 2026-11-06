import type { ToolCallRecord } from './toolCalls'

type Language = 'zh' | 'en'
type Label = readonly [string, string]
export type ToolPresentationStatus = 'running' | 'failed' | 'completed' | 'finished'
export interface ToolPresentation { label: string; summary: string | null; status: ToolPresentationStatus; statusLabel: string }

/** Fixed names and vocabulary only: arbitrary tool arguments are not header text. */
const LABELS: Record<string, Label> = {
  bash: ['运行命令', 'Run command'], read: ['读取文件', 'Read file'], edit: ['编辑文件', 'Edit file'], write: ['写入文件', 'Write file'],
  grep: ['搜索内容', 'Search content'], glob: ['搜索文件', 'Search files'], find: ['搜索', 'Search'], search: ['搜索', 'Search'], web_search: ['搜索网页', 'Search the web'],
  browser_navigate: ['打开网页', 'Open webpage'], browser_click: ['点击网页', 'Click webpage'], browser_type: ['输入内容', 'Enter text'], browser_scroll: ['滚动网页', 'Scroll webpage'], browser_screenshot: ['查看网页截图', 'View screenshot'], browser_snapshot: ['读取网页', 'Read webpage'], browser_back: ['网页后退', 'Go back'], browser_forward: ['网页前进', 'Go forward'], browser_wait: ['等待网页', 'Wait for webpage'], browser_report: ['读取网页报表', 'Read webpage report'], fb_history: ['读取 Facebook 历史', 'Read Facebook history'], inspect_image: ['查看图片', 'Inspect image'],
  todo: ['更新任务计划', 'Update plan'], todo_write: ['更新任务计划', 'Update plan'], todowrite: ['更新任务计划', 'Update plan'], plan: ['更新任务计划', 'Update plan'], task: ['执行子任务', 'Run subtask'], agent: ['执行子任务', 'Run subtask'], subagent: ['执行子任务', 'Run subtask'], spawn: ['执行子任务', 'Run subtask'],
  toushou_tiktok_status: ['检查 TikTok 连接', 'Check TikTok connection'], touhou_tiktok_status: ['检查 TikTok 连接', 'Check TikTok connection'],
  toushou_tiktok_update: ['更新 TikTok 报表', 'Update TikTok report'], touhou_tiktok_update: ['更新 TikTok 报表', 'Update TikTok report'],
  toushou_appsflyer_apps: ['查看 AppsFlyer 应用', 'View AppsFlyer apps'], toushou_appsflyer_query: ['查询 AppsFlyer 归因', 'Query AppsFlyer attribution'],
  mcp__tiktok_ads_auth_advertiser_get: ['查看 TikTok 授权账户', 'View authorized TikTok accounts'],
  mcp__tiktok_ads_advertiser_info_get: ['查看 TikTok 账户信息', 'View TikTok account information'],
  mcp__tiktok_ads_report_integrated_get: ['读取 TikTok 广告报表', 'Read TikTok ads report'],
  auth_advertiser_get: ['查看 TikTok 授权账户', 'View authorized TikTok accounts'],
  advertiser_info_get: ['查看 TikTok 账户信息', 'View TikTok account information'],
  report_integrated_get: ['读取 TikTok 广告报表', 'Read TikTok ads report'],
  mcp__appsflyer_get_apps: ['查看 AppsFlyer 应用', 'View AppsFlyer apps'],
  mcp__appsflyer_analytics_fetch_aggregated_data: ['查询 AppsFlyer 归因', 'Query AppsFlyer attribution'],
  get_apps: ['查看 AppsFlyer 应用', 'View AppsFlyer apps'],
  analytics_fetch_aggregated_data: ['查询 AppsFlyer 归因', 'Query AppsFlyer attribution'],
  toushou_boards_list: ['查看看板列表', 'View boards'], toushou_board_get: ['查看看板', 'View board'], toushou_board_create: ['新建看板', 'Create board'],
  toushou_board_customize: ['定制看板', 'Customize board'], toushou_board_check: ['检查看板', 'Check board'], toushou_af_dataset_pull: ['更新归因数据', 'Update attribution data'],
  toushou_board_build_begin: ['准备看板', 'Prepare board'], toushou_board_build_status: ['查看看板进度', 'View board progress'],
  toushou_board_build_preflight: ['核对看板数据', 'Verify board data'], toushou_board_build_commit: ['保存看板', 'Save board'],
  toushou_board_build_abort: ['取消看板草稿', 'Discard board draft'], toushou_board_refresh: ['刷新看板数据', 'Refresh board data'],
  toushou_board_meta_accounts: ['查看 Meta 账户', 'View Meta accounts'],
  toushou_board_add_widget: ['添加看板组件', 'Add board component'], toushou_board_update_widget: ['修改看板组件', 'Edit board component'], toushou_board_remove_widget: ['移除看板组件', 'Remove board component'], toushou_board_rename: ['重命名看板', 'Rename board'], toushou_dataset_import: ['导入看板数据', 'Import board data'],
  toushou_session_topic: ['整理会话主题', 'Organize conversation topic']
}
const TYPES: Record<string, Label> = {
  file: ['文件', 'File'], note: ['便签', 'Note'], clock: ['时钟', 'Clock'], counter: ['指标', 'Metric'], gauge: ['仪表', 'Gauge'],
  'reading-module': ['读数模块', 'Reading module'], 'reading-snapshot': ['读数快照', 'Reading snapshot'],
  'chart-line': ['折线图', 'Line chart'], 'chart-bar': ['柱状图', 'Bar chart'], todo: ['待办', 'To-do'], link: ['链接', 'Link'],
  table: ['表格', 'Table'], funnel: ['漏斗', 'Funnel'], analysis: ['数据重点', 'Data highlights'],
  'tt-reading': ['TikTok 读数', 'TikTok reading'], 'fb-reading': ['Facebook 读数', 'Facebook reading'], 'fb-reading-summary': ['Facebook 读数汇总', 'Facebook summary'],
  'fb-report-reading': ['Facebook 报表', 'Facebook report'], 'google-report-reading': ['Google 报表', 'Google report']
}
const PROXY_TOOLS = new Set(['toushou_boards_list', 'toushou_board_get', 'toushou_board_create', 'toushou_board_customize', 'toushou_board_check', 'toushou_af_dataset_pull', 'toushou_board_add_widget', 'toushou_board_update_widget', 'toushou_board_remove_widget', 'toushou_board_rename', 'toushou_dataset_import', 'toushou_tiktok_status', 'toushou_tiktok_update', 'toushou_appsflyer_apps', 'toushou_appsflyer_query', 'toushou_board_build_begin', 'toushou_board_build_status', 'toushou_board_build_preflight', 'toushou_board_build_commit', 'toushou_board_build_abort', 'toushou_board_refresh', 'toushou_board_meta_accounts'])
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

/** Examine only known transport envelopes, not arbitrary business fields. */
function outcome(value: unknown, depth = 0): 'failed' | 'completed' | null {
  if (depth > 4) return null
  const record = object(parse(value))
  if (!record) return null
  if (record.isError === true || record.ok === false) return 'failed'
  let completed = record.ok === true
  for (const item of Array.isArray(record.content) ? record.content : []) {
    const child = object(item)
    if (child?.type !== 'text') continue
    const result = outcome(child.text, depth + 1)
    if (result === 'failed') return result
    if (result === 'completed') completed = true
  }
  if (Object.hasOwn(record, 'result')) {
    const result = outcome(record.result, depth + 1)
    if (result === 'failed') return result
    if (result === 'completed') completed = true
  }
  return completed ? 'completed' : null
}

// Store and history mapping replace a ToolCallRecord when its result arrives.
// Weak keys avoid retaining transcripts or provider payloads after a session closes.
const presentations = new WeakMap<ToolCallRecord, Partial<Record<Language, ToolPresentation>>>()
export function presentToolCall(call: ToolCallRecord, language: Language): ToolPresentation {
  const cached = presentations.get(call)?.[language]
  if (cached) return cached
  const result = computeToolPresentation(call, language)
  const perLanguage = presentations.get(call) ?? {}
  perLanguage[language] = result
  presentations.set(call, perLanguage)
  return result
}

function computeToolPresentation(call: ToolCallRecord, language: Language): ToolPresentation {
  const zh = language === 'zh'
  const name = call.tool.toLowerCase()
  let action = name
  let input = object(parse(call.input))
  const viewingSchema = name === 'read' && typeof input?.path === 'string' && /^xd:\/\/toushou_[a-z0-9_]{1,112}$/.test(input.path)
  if (name === 'write' && typeof input?.path === 'string' && input.path.startsWith('xd://')) {
    const proxy = /^xd:\/\/(toushou_[a-z0-9_]+)$/.exec(input.path)?.[1]
    action = proxy && PROXY_TOOLS.has(proxy) ? proxy : ''
    input = object(parse(input.content))
  }
  // The runtime may already have normalized an xd proxy and removed its path.
  if (PROXY_TOOLS.has(action) && typeof input?.content === 'string') input = object(parse(input.content))
  const label: Label = viewingSchema ? ['查看工具说明', 'View tool instructions'] : LABELS[action] ?? (action.startsWith('feishu_') ? ['飞书操作', 'Feishu action'] : action.startsWith('browser_') ? ['浏览器操作', 'Browser action'] : ['工具调用', 'Tool call'])
  const type = action === 'toushou_board_add_widget' && typeof input?.type === 'string' ? TYPES[input.type] : undefined
  const known = Boolean(LABELS[action] || action.startsWith('feishu_') || action.startsWith('browser_'))
  const result = call.output === undefined ? null : outcome(call.output)
  const status: ToolPresentationStatus = call.isError ? 'failed' : call.output === undefined ? 'running' : result === 'failed' ? 'failed' : result === 'completed' && known ? 'completed' : 'finished'
  const labels: Record<ToolPresentationStatus, Label> = { running: ['进行中', 'In progress'], failed: ['失败', 'Failed'], completed: ['已完成', 'Completed'], finished: ['已结束', 'Finished'] }
  return { label: label[zh ? 0 : 1], summary: type?.[zh ? 0 : 1] ?? null, status, statusLabel: labels[status][zh ? 0 : 1] }
}
