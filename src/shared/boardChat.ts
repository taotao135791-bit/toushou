import { BoardDataset, BoardWidget, KanbanBoard, Language } from './types'

/**
 * A bounded, reviewable snapshot used when a user asks the chat agent about a
 * board. It intentionally excludes dataset rows and note bodies: clicking
 * “ask agent” should give useful layout/KPI context without silently exporting
 * the board's raw data. The result is a composer draft, never an auto-sent
 * prompt, so the user can edit it before it leaves the app.
 */

const MAX_WIDGETS = 40
const MAX_DATASETS = 12
const MAX_COLUMNS = 24
const MAX_TEXT = 12_000

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`
}

function configuredBinding(widget: BoardWidget): string {
  if (widget.config.source !== 'dataset') return ''
  const dataset = typeof widget.config.datasetId === 'string' ? widget.config.datasetId : '?'
  const metric = typeof widget.config.metric === 'string' ? widget.config.metric : '?'
  const dimension = typeof widget.config.dimension === 'string' ? widget.config.dimension : ''
  const op = typeof widget.config.op === 'string' ? widget.config.op : 'sum'
  return `data binding: ${dataset} / ${metric}${dimension ? ` by ${dimension}` : ''} / ${op}`
}

function widgetSummary(widget: BoardWidget): string {
  const title = compact(widget.title || widget.type, 100)
  let detail = ''
  switch (widget.type) {
    case 'clock':
      detail = widget.config.showSeconds === false ? 'time (minutes)' : 'time (seconds shown)'
      break
    case 'note': {
      const characters = typeof widget.config.text === 'string' ? widget.config.text.length : 0
      detail = characters ? `note text withheld (${characters} characters)` : 'empty note'
      break
    }
    case 'counter':
      detail = configuredBinding(widget) || `value: ${typeof widget.config.value === 'number' ? widget.config.value : 0}`
      break
    case 'gauge':
      detail = `value: ${typeof widget.config.value === 'number' ? widget.config.value : 0}%`
      break
    case 'chart-line':
    case 'chart-bar': {
      const points = Array.isArray(widget.config.points) ? widget.config.points.length : 0
      detail = configuredBinding(widget) || `${points} manual data points`
      break
    }
    case 'todo': {
      const items = Array.isArray(widget.config.items) ? widget.config.items : []
      const done = items.filter((item) => item && typeof item === 'object' && (item as { done?: unknown }).done === true).length
      detail = `${done}/${items.length} tasks completed`
      break
    }
    case 'link': {
      const rawUrl = typeof widget.config.url === 'string' ? widget.config.url : ''
      try {
        detail = `link: ${new URL(rawUrl).host}`
      } catch {
        detail = 'configured link'
      }
      break
    }
  }
  return `- ${title} (${widget.type}): ${detail}`
}

function datasetSummary(dataset: BoardDataset): string {
  const columns = dataset.columns
    .slice(0, MAX_COLUMNS)
    .map((column) => `${compact(column.name, 50)}:${column.type}`)
    .join(', ')
  const suffix = dataset.columns.length > MAX_COLUMNS ? ', …' : ''
  return `- ${compact(dataset.name, 100)}: ${dataset.rows.length} rows; ${columns}${suffix}`
}

export function buildBoardChatPrompt(
  board: KanbanBoard,
  datasets: BoardDataset[],
  language: Language = 'en'
): string {
  const widgets = board.widgets.slice(0, MAX_WIDGETS).map(widgetSummary)
  const datasetLines = datasets.slice(0, MAX_DATASETS).map(datasetSummary)
  const isChinese = language === 'zh'
  const content = isChinese
    ? [
        '请基于下面的本地看板快照帮助我分析和规划。它只是只读上下文：不要声称你已经修改了看板；如建议改动，请列出可执行的组件/数据/布局建议。',
        '',
        `看板：${compact(board.name, 200)}`,
        board.description ? `用途：${compact(board.description, 1000)}` : '',
        `组件（${board.widgets.length} 个）：`,
        ...(widgets.length ? widgets : ['- 暂无组件']),
        board.widgets.length > MAX_WIDGETS ? `- 其余 ${board.widgets.length - MAX_WIDGETS} 个组件未列出` : '',
        '',
        `可用数据集（仅模式，未包含数据行；${datasets.length} 个）：`,
        ...(datasetLines.length ? datasetLines : ['- 暂无数据集']),
        datasets.length > MAX_DATASETS ? `- 其余 ${datasets.length - MAX_DATASETS} 个数据集未列出` : '',
        '',
        '请先说明你观察到的重点、风险或缺口，再给出下一步建议。'
      ]
    : [
        'Help me analyze and plan from this local board snapshot. Treat it as read-only context: do not claim that you edited the board. If you suggest changes, make the widget, data, or layout steps explicit.',
        '',
        `Board: ${compact(board.name, 200)}`,
        board.description ? `Purpose: ${compact(board.description, 1000)}` : '',
        `Widgets (${board.widgets.length}):`,
        ...(widgets.length ? widgets : ['- none yet']),
        board.widgets.length > MAX_WIDGETS ? `- ${board.widgets.length - MAX_WIDGETS} more widgets omitted` : '',
        '',
        `Available datasets (schema only; no data rows; ${datasets.length}):`,
        ...(datasetLines.length ? datasetLines : ['- none yet']),
        datasets.length > MAX_DATASETS ? `- ${datasets.length - MAX_DATASETS} more datasets omitted` : '',
        '',
        'First identify the key observations, risks, or gaps, then suggest the next steps.'
      ]
  return content.filter(Boolean).join('\n').slice(0, MAX_TEXT)
}
