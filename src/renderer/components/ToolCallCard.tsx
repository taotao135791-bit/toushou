import { memo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { ToolCallRecord } from '../lib/toolCalls'
import { I18nKey, useT } from '../i18n'
import { getToolRenderer } from './tools'

interface ToolCallCardProps {
  toolCall: ToolCallRecord
}

/**
 * Semantic per-tool labels — the step stream reads as actions ("打开网页"),
 * not plumbing ("browser_navigate"). Unknown tools fall back to the raw name.
 */
const TOOL_LABEL_KEYS: Record<string, I18nKey> = {
  bash: 'tool.label.bash',
  read: 'tool.label.read',
  edit: 'tool.label.edit',
  write: 'tool.label.write',
  grep: 'tool.label.search',
  glob: 'tool.label.search',
  find: 'tool.label.search',
  search: 'tool.label.search',
  web_search: 'tool.label.webSearch',
  browser_navigate: 'tool.label.browserNavigate',
  browser_click: 'tool.label.browserClick',
  browser_type: 'tool.label.browserType',
  browser_scroll: 'tool.label.browserScroll',
  browser_screenshot: 'tool.label.browserScreenshot',
  browser_snapshot: 'tool.label.browserSnapshot',
  browser_back: 'tool.label.browserBack',
  browser_forward: 'tool.label.browserForward',
  browser_wait: 'tool.label.browserWait',
  inspect_image: 'tool.label.inspectImage',
  todo: 'tool.label.todo',
  todo_write: 'tool.label.todo',
  todowrite: 'tool.label.todo',
  plan: 'tool.label.todo',
  task: 'tool.label.subagent',
  agent: 'tool.label.subagent',
  subagent: 'tool.label.subagent',
  spawn: 'tool.label.subagent'
}

function toolLabelKey(tool: string): I18nKey | null {
  const name = tool.toLowerCase()
  if (TOOL_LABEL_KEYS[name]) return TOOL_LABEL_KEYS[name]
  if (name.startsWith('feishu_')) return 'tool.label.feishu'
  if (name.startsWith('browser_')) return 'tool.label.browser'
  return null
}

/** One-line summary of a tool call's input, shown in the collapsed header. */
function summarizeInput(tool: string, input: unknown): string | null {
  if (input === undefined || input === null) return null
  const name = tool.toLowerCase()
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (name === 'bash' && typeof obj.command === 'string') {
      return obj.command.split('\n', 1)[0]
    }
    if ((name === 'read' || name === 'edit' || name === 'write') && typeof obj.path === 'string') {
      return obj.path
    }
    if (name.endsWith('screenshot')) return null
    if (name.startsWith('browser_')) {
      if (typeof obj.url === 'string' && obj.url) return obj.url
      if (typeof obj.selector === 'string' && obj.selector) return obj.selector
      if (typeof obj.query === 'string' && obj.query) return obj.query
      return null
    }
    if (name.startsWith('feishu_') && typeof obj.action === 'string') {
      return obj.action
    }
    if (name === 'todo' || name === 'todo_write' || name === 'todowrite' || name === 'plan') {
      return null
    }
  }
  try {
    return JSON.stringify(input)?.slice(0, 40) ?? null
  } catch {
    return null
  }
}

function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const summary = summarizeInput(toolCall.tool, toolCall.input)
  const running = toolCall.output === undefined
  // Expanded content comes from the per-tool renderer (tools/ registry).
  const Content = getToolRenderer(toolCall.tool)
  const labelKey = toolLabelKey(toolCall.tool)
  const label = labelKey ? t(labelKey) : toolCall.tool

  // Borderless one-line row; the surrounding group container (MessageList)
  // draws the box and hairline separators between consecutive tool calls.
  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full items-center gap-2.5 px-3 text-left transition-colors hover:bg-overlay"
      >
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-amber-500" />
        ) : (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              toolCall.isError ? 'bg-red-500' : 'bg-emerald-500'
            }`}
          />
        )}
        <span className="shrink-0 text-[13px] font-medium text-cream">{label}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-cream-faint">
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0 text-cream-faint">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded && (
        <div className="fade-in mb-2.5 ml-[14px] mr-3 border-l-2 border-line py-0.5 pl-3">
          <Content toolCall={toolCall} />
        </div>
      )}
    </div>
  )
}

/** Memoized: a tool record's identity is stable until its result lands. */
export default memo(ToolCallCard)
