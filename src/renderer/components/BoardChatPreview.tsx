import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronDown, LayoutDashboard } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { ToolCallRecord } from '../lib/toolCalls'
import { useAppStore } from '../store'

type Preview = { ok: true; html: string; source: 'snapshot' | 'module' | 'file'; boardName: string; widgetTitle: string } | { ok: false; error: string }
type PreviewApi = { getChatBoardPreview(input: { sessionId: string; boardId: string; widgetId: string }): Promise<Preview> }

/** Tool output is only a reference. Main independently authorizes and renders it. */
export interface BoardPreviewReference { boardId: string; widgetId: string; revision?: number }
const references = new WeakMap<ToolCallRecord, BoardPreviewReference | null>()
export function boardPreviewReference(call: ToolCallRecord): BoardPreviewReference | null {
  if (references.has(call)) return references.get(call) ?? null
  const reference = parseBoardPreviewReference(call)
  references.set(call, reference)
  return reference
}

function parseBoardPreviewReference(call: ToolCallRecord): BoardPreviewReference | null {
  const parseObject = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) } catch { return null }
  }
  const raw = call as ToolCallRecord & { name?: unknown; args?: unknown; arguments?: unknown; result?: unknown }
  const tool = call.tool ?? raw.name
  const proxyInput = parseObject(call.input ?? raw.args ?? raw.arguments)
  const proxyPath = proxyInput && typeof proxyInput === 'object' ? (proxyInput as { path?: unknown }).path : undefined
  const action = tool === 'write' && (proxyPath === 'xd://toushou_board_add_widget' || proxyPath === 'xd://toushou_board_update_widget') ? proxyPath.slice('xd://'.length) : tool
  const output = call.output ?? raw.result
  if (!['toushou_board_add_widget', 'toushou_board_update_widget'].includes(String(action)) || call.isError || output === undefined) return null
  let value: unknown = output
  try {
    for (let depth = 0; depth < 3; depth++) {
      if (typeof value === 'string') { value = JSON.parse(value); continue }
      if (typeof value === 'object' && value !== null && 'content' in value) {
        const content = (value as { content?: unknown }).content
        if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') return null
        value = content[0].text
        continue
      }
      break
    }
  } catch { return null }
  if (!value || typeof value !== 'object') return null
  const result = value as { ok?: unknown; board?: { id?: unknown; updatedAt?: unknown; widgets?: unknown }; createdWidgetId?: unknown }
  const rawInput = proxyPath ? (proxyInput as { content?: unknown }).content : proxyInput
  let input = parseObject(rawInput) as { widgetId?: unknown; content?: unknown } | null
  if (input && typeof input === 'object' && !Array.isArray(input) && input.content !== undefined) input = parseObject(input.content) as typeof input
  const widgetId = action === 'toushou_board_add_widget' ? result.createdWidgetId : input?.widgetId
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100 && !/[\x00-\x1f\x7f]/.test(id)
  if (result.ok !== true || !validId(result.board?.id) || !validId(widgetId)) return null
  if (Array.isArray(result.board.widgets)) {
    const saved = result.board.widgets.find(widget => widget && typeof widget === 'object' && widget.id === widgetId)
    if (!saved || !['file', 'reading-module', 'reading-snapshot'].includes(saved.type)) return null
  } else if (action === 'toushou_board_update_widget') return null
  const revision = result.board.updatedAt
  return { boardId: result.board.id, widgetId, ...(typeof revision === 'number' && Number.isFinite(revision) ? { revision } : {}) }
}

/** One result card per board, with duplicate component references folded. */
export function groupBoardPreviews(references: BoardPreviewReference[]): { boardId: string; widgetIds: string[]; revision?: number }[] {
  const groups = new Map<string, { boardId: string; widgetIds: string[]; revision?: number }>()
  for (const reference of references) {
    const group = groups.get(reference.boardId) ?? { boardId: reference.boardId, widgetIds: [] }
    if (!group.widgetIds.includes(reference.widgetId)) group.widgetIds.push(reference.widgetId)
    if (reference.revision !== undefined) group.revision = reference.revision
    groups.set(reference.boardId, group)
  }
  return [...groups.values()]
}

export default function BoardChatPreview({ sessionId, boardId, widgetId, widgetIds = [widgetId], revision }: { sessionId: string; boardId: string; widgetId: string; widgetIds?: string[]; revision?: number }) {
  const navigate = useNavigate()
  const zh = useAppStore(state => state.language) === 'zh'
  const [result, setResult] = useState<Preview | null>(null)
  const [selected, setSelected] = useState(widgetId)
  const [expanded, setExpanded] = useState(false)
  const active = widgetIds.includes(selected) ? selected : widgetId
  useEffect(() => {
    let alive = true
    setResult(null)
    const api = window.electronAPI as typeof window.electronAPI & Partial<PreviewApi>
    if (!api.getChatBoardPreview) { setResult({ ok: false, error: 'unavailable' }); return () => { alive = false } }
    void api.getChatBoardPreview({ sessionId, boardId, widgetId: active }).then(value => { if (alive) setResult(value) }).catch(() => { if (alive) setResult({ ok: false, error: 'unavailable' }) })
    return () => { alive = false }
  }, [sessionId, boardId, active, revision])
  const open = () => navigate(`/boards?${new URLSearchParams({ board: boardId, widget: active }).toString()}`)
  return <section aria-label={zh ? '看板预览' : 'Board preview'} className="min-w-0 overflow-hidden rounded-2xl border border-line bg-ink-850">
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2.5"><LayoutDashboard size={16} className="shrink-0 text-cream-dim" aria-hidden="true" /><div className="min-w-0"><p className="truncate text-[13px] font-semibold text-cream" title={result?.ok ? result.boardName : undefined}>{result?.ok ? result.boardName : (zh ? '看板预览' : 'Board preview')}</p><p className="truncate text-[12px] text-cream-faint" title={result?.ok ? result.widgetTitle : undefined}>{result?.ok ? result.widgetTitle : (zh ? '读取已保存的组件' : 'Saved component')}</p></div></div>
      <button type="button" onClick={open} className="focus-ring flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-cream transition-colors hover:bg-overlay">{zh ? '打开看板' : 'Open board'}<ArrowUpRight size={13} aria-hidden="true" /></button>
    </div>
    {widgetIds.length > 1 && <div className="flex gap-1 overflow-x-auto border-t border-line px-3 py-2" role="group" aria-label={zh ? '切换组件预览' : 'Choose component preview'}>{widgetIds.map((id, index) => <button key={id} type="button" aria-pressed={active === id} onClick={() => setSelected(id)} className={`focus-ring min-h-7 shrink-0 rounded-md px-2 text-[12px] transition-colors ${active === id ? 'bg-overlay text-cream' : 'text-cream-dim hover:bg-overlay'}`}>{zh ? `画面 ${index + 1}` : `View ${index + 1}`}</button>)}</div>}
    {result?.ok && <p className="px-4 pb-3 text-[12px] text-cream-faint">{result.source === 'file' ? (zh ? '文件静态预览；内容未经快照校验。' : 'Static file preview; content has not been verified against a snapshot.') : (zh ? '已保存的组件预览；日期与来源以看板为准。' : 'Saved component preview; check the board for dates and sources.')}</p>}
    {!result && <p role="status" className="px-3 pb-3 text-[12px] text-cream-faint">{zh ? '正在读取已保存的组件…' : 'Loading saved component…'}</p>}
    {result && !result.ok && <p role="status" className="px-3 pb-3 text-[12px] text-cream-faint">{zh ? '此组件暂无对话预览，可打开看板查看。' : 'Preview unavailable. Open the board to view it.'}</p>}
    {result?.ok && <><iframe title={zh ? '已保存的看板预览' : 'Saved board preview'} sandbox="" srcDoc={result.html} className={`block w-full border-0 bg-white ${expanded ? 'h-[560px]' : 'h-[280px]'}`} /><button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} className="focus-ring flex min-h-9 w-full items-center justify-center gap-1.5 border-t border-line text-[12px] text-cream-dim transition-colors hover:bg-overlay">{expanded ? (zh ? '收起画面' : 'Collapse preview') : (zh ? '展开画面' : 'Expand preview')}<ChevronDown size={13} className={expanded ? 'rotate-180' : ''} aria-hidden="true" /></button></>}
  </section>
}
