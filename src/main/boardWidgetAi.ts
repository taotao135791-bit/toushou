import { spawnCommand } from './command'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectCli } from './omp'
import { configGet, configPath, makeExecRunner } from './omp/settings/OmpConfigCli'
import { prepareIsolatedAiHome } from './htmlBoardAi'

/**
 * AI 看板卡片生成：用户一句描述 + 当前看板上下文 → 默认对话模型产出一张
 * 卡片的配置提案。复用 htmlBoardAi 的隔离运行时先例（独立 HOME 只携带
 * 模型配置、一次性 `omp @prompt.md` 无会话调用），所以：
 *   - 用的是运行时的默认对话模型（modelRoles.default），不新建可见会话；
 *   - 模型输出只作为"提案"返回给渲染层，验证通过后仍由用户确认添加。
 *
 * 安全校验与 board_add_widget 工具同口径：类型白名单、datasetId/metric/
 * dimension/columns 必须真实存在于所提供的数据集。模型不能发明列名。
 */

const ARGS_BASE = ['--mode', 'json', '--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-title', '--max-time=120', '--thinking=off']

const WIDGET_TYPES = ['counter', 'gauge', 'chart-line', 'chart-bar', 'table', 'funnel', 'analysis', 'note'] as const
type AiWidgetType = (typeof WIDGET_TYPES)[number]
const OPS = ['sum', 'avg', 'count', 'max', 'min'] as const
type AiOp = (typeof OPS)[number]

export interface AiWidgetDatasetSummary {
  id: string
  name: string
  columns: Array<{ name: string; type: 'number' | 'date' | 'text' }>
  rowCount: number
}

export interface AiWidgetBoardContext {
  widgets: Array<{ type: string; title: string }>
  datasets: AiWidgetDatasetSummary[]
}

export interface AiWidgetProposal {
  type: AiWidgetType
  title: string
  config: Record<string, unknown>
  reason: string
}

export type AiWidgetResult =
  | { ok: true; proposal: AiWidgetProposal }
  | { ok: false; error: 'invalid-input' | 'unavailable' | 'timeout' | 'failed' | 'invalid-output' | 'no-dataset' }

const MAX_INSTRUCTION = 600
const MAX_TITLE = 60

function isPlainString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
}

/** Validate the model's proposal against the REAL datasets — no invented names. */
export function validateProposal(candidate: unknown, datasets: AiWidgetDatasetSummary[]): AiWidgetProposal | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const raw = candidate as Record<string, unknown>
  const type = raw.type as AiWidgetType
  if (!WIDGET_TYPES.includes(type)) return null
  if (!isPlainString(raw.title, MAX_TITLE)) return null
  const config = raw.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const reason = isPlainString(raw.reason, 300) ? raw.reason : ''
  const findDataset = (id: unknown): AiWidgetDatasetSummary | null =>
    typeof id === 'string' ? datasets.find(dataset => dataset.id === id || dataset.name === id) ?? null : null
  const columnExists = (dataset: AiWidgetDatasetSummary, name: unknown): name is string =>
    typeof name === 'string' && dataset.columns.some(column => column.name === name)
  const op = (value: unknown): AiOp => OPS.includes(value as AiOp) ? value as AiOp : 'sum'
  const numericColumn = (dataset: AiWidgetDatasetSummary, name: unknown): name is string =>
    columnExists(dataset, name) && dataset.columns.find(column => column.name === name)!.type === 'number'

  if (type === 'note') {
    const text = raw.config as { text?: unknown }
    return isPlainString((text as { text?: unknown })?.text, 600) ? { type, title: raw.title, config: { text: (text as { text: string }).text }, reason } : null
  }

  // 漏斗的每个阶段自带数据集，顶层没有 datasetId——必须在顶层绑定校验之前处理，
  // 否则 AI 生成的漏斗永远被判非法。
  if (type === 'funnel') {
    const stages = (config as { stages?: unknown }).stages
    if (!Array.isArray(stages) || stages.length < 2 || stages.length > 12) return null
    const built: Array<Record<string, unknown>> = []
    for (const stage of stages) {
      if (!stage || typeof stage !== 'object') return null
      const entry = stage as Record<string, unknown>
      const stageDataset = findDataset(entry.datasetId)
      if (!stageDataset || !isPlainString(entry.label, 100) || !numericColumn(stageDataset, entry.metric)) return null
      built.push({ label: entry.label, datasetId: stageDataset.id, metric: entry.metric, op: op(entry.op) })
    }
    return { type, title: raw.title, config: { stages: built }, reason }
  }

  const dataset = findDataset((config as { datasetId?: unknown }).datasetId)
  if (!dataset) return null
  const base = { source: 'dataset', datasetId: dataset.id }

  if (type === 'counter') {
    const metric = (config as { metric?: unknown }).metric
    if (!numericColumn(dataset, metric)) return null
    return { type, title: raw.title, config: { ...base, metric, op: op((config as { op?: unknown }).op) }, reason }
  }
  if (type === 'chart-line' || type === 'chart-bar') {
    const metric = (config as { metric?: unknown }).metric
    const dimension = (config as { dimension?: unknown }).dimension
    if (!numericColumn(dataset, metric) || !columnExists(dataset, dimension)) return null
    return { type, title: raw.title, config: { ...base, metric, dimension, op: op((config as { op?: unknown }).op) }, reason }
  }
  if (type === 'analysis') {
    const metric = (config as { metric?: unknown }).metric
    if (!numericColumn(dataset, metric)) return null
    const dimension = (config as { dimension?: unknown }).dimension
    const configOut: Record<string, unknown> = { ...base, metric, op: op((config as { op?: unknown }).op) }
    if (columnExists(dataset, dimension)) configOut.dimension = dimension
    return { type, title: raw.title, config: configOut, reason }
  }
  if (type === 'table') {
    const requested = (config as { columns?: unknown }).columns
    const columns = Array.isArray(requested)
      ? requested.filter((name): name is string => columnExists(dataset, name)).slice(0, 12)
      : []
    return { type, title: raw.title, config: { ...base, ...(columns.length ? { columns } : {}) }, reason }
  }
  return null
}

function buildPrompt(instruction: string, context: AiWidgetBoardContext): string {
  const datasetBrief = context.datasets.map(dataset =>
    `${dataset.name} (datasetId: ${dataset.id}, ${dataset.rowCount} 行) 列: ${dataset.columns.map(column => `${column.name}[${column.type === 'number' ? '数值' : column.type === 'date' ? '日期' : '文本'}]`).join('、')}`
  ).join('\n')
  const widgetBrief = context.widgets.map(widget => `${widget.title} (${widget.type})`).join('、') || '（空看板）'
  return [
    '你是广告优化师的看板助手。根据用户描述和现有看板，设计"一张"新卡片。只输出 JSON，无解释、无 Markdown 围栏。',
    'JSON 结构: {"type":"counter|chart-line|chart-bar|table|funnel|analysis|note","title":"卡片标题(简短业务名)","config":{...},"reason":"一句话说明为什么这样设计"}',
    'config 规则（只能引用下面列出的真实 datasetId 和列名，数值指标必须是数值列；日期趋势的 dimension 用日期列）:',
    '- counter: {source:"dataset",datasetId,metric,op:"sum|avg"}',
    '- chart-line/chart-bar: {source:"dataset",datasetId,metric,dimension,op}',
    '- table: {source:"dataset",datasetId,columns:[最多12个真实列名]}',
    '- analysis: {source:"dataset",datasetId,metric,op,dimension?}',
    '- funnel: {stages:[{label,datasetId,metric,op}] 2~12段}',
    '- note: {text:"一段说明文字"}',
    '注意: 独立用户/活跃用户类列不能跨行相加；留存率/百分比类指标 op 用 avg；不编造任何列名或数据。标题语言跟用户描述的语言。',
    `现有卡片: ${widgetBrief}`,
    `可用数据集:\n${datasetBrief}`,
    `用户描述: ${instruction}`
  ].join('\n')
}

/** Parse the fenced-or-raw JSON object out of a one-shot model response. */
function parseProposal(response: string): unknown | null {
  const trimmed = response.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
  const candidate = (fenced ? fenced[1] : trimmed).replace(/^[^{]*/, '').replace(/[^}]*$/, '')
  try { return JSON.parse(candidate) } catch { return null }
}

const active = new Set<string>()

export async function requestAiBoardWidget(raw: {
  requestId: string
  instruction: string
  context: AiWidgetBoardContext
}, deps: { timeoutMs?: number } = {}): Promise<AiWidgetResult> {
  if (!isPlainString(raw.requestId, 100) || !isPlainString(raw.instruction, MAX_INSTRUCTION)) return { ok: false, error: 'invalid-input' }
  if (!Array.isArray(raw.context?.datasets) || raw.context.datasets.length === 0) return { ok: false, error: 'no-dataset' }
  if (active.has(raw.requestId) || active.size >= 2) return { ok: false, error: 'failed' }
  if (raw.context.datasets.length > 30 || raw.context.widgets.length > 80) return { ok: false, error: 'invalid-input' }
  active.add(raw.requestId)
  const deadline = Date.now() + (deps.timeoutMs ?? 130_000)
  let directory: string | undefined
  try {
    const cli = detectCli()
    if (!cli.available || cli.command !== 'omp') return { ok: false, error: 'unavailable' }
    directory = mkdtempSync(path.join(tmpdir(), 'toushou-widget-ai-'))
    const runner = makeExecRunner(cli.path ?? cli.command)
    const entry = await configGet(runner, 'modelRoles')
    const selector = entry && typeof entry.value === 'object' && !Array.isArray(entry.value) && typeof (entry.value as Record<string, unknown>).default === 'string' ? (entry.value as Record<string, string>).default : ''
    const sourceAgent = await configPath(runner)
    if (!sourceAgent) return { ok: false, error: 'unavailable' }
    const env = prepareIsolatedAiHome(path.join(directory, 'home'), sourceAgent, selector)
    const prompt = buildPrompt(raw.instruction.trim(), raw.context)
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ok: false, error: 'timeout' }
      writeFileSync(path.join(directory, 'prompt.md'), prompt, { encoding: 'utf8', mode: 0o600 })
      const response = await new Promise<string | null>(resolve => {
        let done = false, pending = '', out = ''
        const decoder = new (require('node:string_decoder').StringDecoder)('utf8')
        // Declared before finish(): a synchronous spawn throw calls finish()
        // immediately, and clearTimeout(timer) in its TDZ would crash instead
        // of returning the intended failure.
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (value: string | null) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(value) } }
        let child: import('node:child_process').ChildProcess
        try {
          child = spawnCommand(cli.path ?? cli.command, [...ARGS_BASE, '@prompt.md'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        } catch { finish(null); return }
        timer = setTimeout(() => { finish(null); child.kill() }, remaining)
        child.stdout?.on('data', (chunk: Buffer) => {
          pending += decoder.write(chunk)
          let index: number
          while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index)
            pending = pending.slice(index + 1)
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> } }
              if (event.type === 'message_end' && event.message?.role === 'assistant') {
                if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') { finish(null); child.kill(); return }
                out = (event.message.content ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text as string).join('')
                finish(out)
                child.kill()
              }
            } catch { /* non-JSON line */ }
          }
        })
        child.stderr?.on('data', () => {})
        child.on('error', () => finish(null))
        child.on('close', () => finish(out || null))
      })
      if (response) {
        const proposal = validateProposal(parseProposal(response), raw.context.datasets)
        if (proposal) return { ok: true, proposal }
      }
    }
    return { ok: false, error: 'invalid-output' }
  } finally {
    active.delete(raw.requestId)
    if (directory) { try { rmSync(directory, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}
