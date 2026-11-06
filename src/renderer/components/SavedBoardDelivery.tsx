import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, LayoutDashboard } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { KanbanBoard } from '@shared/types'
import type { ToolCallRecord } from '../lib/toolCalls'
import { useAppStore } from '../store'

export interface SavedBoardReference { boardId: string; widgetId: string; revision?: number }
const actions = new Set(['toushou_board_create', 'toushou_board_add_widget', 'toushou_board_update_widget', 'toushou_board_customize', 'toushou_board_build_commit'])
const nativeTypes = new Set(['clock', 'note', 'counter', 'fb-reading', 'fb-reading-summary', 'fb-report-reading', 'google-report-reading', 'tt-reading', 'meta-reading', 'gauge', 'chart-line', 'chart-bar', 'table', 'funnel', 'analysis', 'todo', 'link'])
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const parse = (value: unknown): unknown => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return null } }

/** Tool output contributes identity only; the card independently verifies saved metadata. */
export function savedBoardReference(call: ToolCallRecord): SavedBoardReference | null {
  if (call.isError) return null
  const raw = call as ToolCallRecord & { name?: unknown; args?: unknown; arguments?: unknown; result?: unknown }
  const input = parse(call.input ?? raw.args ?? raw.arguments)
  const tool = call.tool ?? raw.name
  const path = object(input) ? input.path : undefined
  const action = tool === 'write' && typeof path === 'string' && path.startsWith('xd://') ? path.slice(5) : tool
  if (!actions.has(String(action))) return null
  let result: unknown = call.output ?? raw.result
  for (let depth = 0; depth < 5; depth++) {
    if (typeof result === 'string') { result = parse(result); continue }
    if (object(result) && Array.isArray(result.content) && result.content.length === 1 && object(result.content[0]) && result.content[0].type === 'text') { result = result.content[0].text; continue }
    break
  }
  if (!object(result) || result.ok !== true || result.preview === true || result.draft === true || result.published === false || !object(result.board) || !validId(result.board.id) || !Array.isArray(result.board.widgets)) return null
  let target: unknown = result.createdWidgetId
  const rawArgs = parse(typeof path === 'string' && object(input) ? input.content : input)
  if (action === 'toushou_board_update_widget' && object(rawArgs)) target = rawArgs.widgetId
  const widget = result.board.widgets.find(value => object(value) && validId(value.id) && nativeTypes.has(String(value.type)) && (!validId(target) || value.id === target))
  if (!object(widget) || !validId(widget.id)) return null
  return { boardId: result.board.id, widgetId: widget.id, ...(typeof result.board.updatedAt === 'number' && Number.isFinite(result.board.updatedAt) ? { revision: result.board.updatedAt } : {}) }
}

export function groupSavedBoards(references: SavedBoardReference[]): SavedBoardReference[] {
  const groups = new Map<string, SavedBoardReference>()
  for (const reference of references) groups.set(reference.boardId, reference)
  return [...groups.values()]
}

export default function SavedBoardDelivery({ sessionId, reference }: { sessionId: string; reference: SavedBoardReference }) {
  const navigate = useNavigate()
  const zh = useAppStore(state => state.language) === 'zh'
  const [board, setBoard] = useState<Pick<KanbanBoard, 'name' | 'widgets'> | null>(null)
  const [pending, setPending] = useState(true)
  useEffect(() => {
    let alive = true
    setPending(true); setBoard(null)
    void (async () => {
      try {
        // Preserve Main's session/workspace authority. Unsupported means the
        // native widget exists, is authorized, and simply has no HTML preview.
        const checked = await window.electronAPI.getChatBoardPreview({ sessionId, boardId: reference.boardId, widgetId: reference.widgetId })
        if (checked.ok || checked.error !== 'unsupported') return
        const saved = (await window.electronAPI.listBoards()).find(item => item.id === reference.boardId && item.widgets.some(widget => widget.id === reference.widgetId))
        if (alive && saved) setBoard({ name: saved.name, widgets: saved.widgets })
      } catch { /* The existing board route remains a user-directed recovery. */ }
      finally { if (alive) setPending(false) }
    })()
    return () => { alive = false }
  }, [sessionId, reference.boardId, reference.widgetId, reference.revision])
  return <section aria-label={zh ? '看板成果' : 'Board result'} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-ink-850 px-4 py-3">
    <div className="flex min-w-0 flex-1 items-center gap-3"><LayoutDashboard size={18} className="shrink-0 text-cream-dim" aria-hidden="true" /><div className="min-w-0"><p className="truncate text-[13px] font-semibold text-cream" title={board?.name}>{board?.name ?? (zh ? '看板' : 'Board')}</p><p role="status" className="mt-0.5 flex items-center gap-1 text-[12px] text-cream-faint">{board ? <><Check size={12} aria-hidden="true" />{zh ? `已保存 · ${board.widgets.length} 个模块` : `Saved · ${board.widgets.length} ${board.widgets.length === 1 ? 'module' : 'modules'}`}</> : pending ? (zh ? '正在核对已保存内容…' : 'Checking saved content…') : (zh ? '打开看板查看' : 'Open the board to view it')}</p></div></div>
    <button type="button" onClick={() => navigate(`/boards?${new URLSearchParams({ board: reference.boardId, widget: reference.widgetId }).toString()}`)} className="focus-ring flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-cream transition-colors hover:bg-overlay">{zh ? '打开看板' : 'Open board'}<ArrowUpRight size={13} aria-hidden="true" /></button>
  </section>
}
