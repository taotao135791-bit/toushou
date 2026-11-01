import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ToolCallRecord } from '../lib/toolCalls'
import { useAppStore } from '../store'

type Preview = { ok: true; html: string; source: 'snapshot' | 'module' | 'file'; boardName: string; widgetTitle: string } | { ok: false; error: string }
type PreviewApi = { getChatBoardPreview(input: { sessionId: string; boardId: string; widgetId: string }): Promise<Preview> }

/** Tool output is only a reference. Main independently authorizes and renders it. */
export function boardPreviewReference(call: ToolCallRecord): { boardId: string; widgetId: string } | null {
  const parseObject = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) } catch { return null }
  }
  const raw = call as ToolCallRecord & { name?: unknown; args?: unknown; arguments?: unknown; result?: unknown }
  const tool = call.tool ?? raw.name
  const proxyInput = parseObject(call.input ?? raw.args ?? raw.arguments)
  const isProxy = tool === 'write' && !!proxyInput && typeof proxyInput === 'object' && (proxyInput as { path?: unknown }).path === 'xd://toushou_board_add_widget'
  const output = call.output ?? raw.result
  if ((tool !== 'toushou_board_add_widget' && !isProxy) || call.isError || output === undefined) return null
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
  const result = value as { ok?: unknown; board?: { id?: unknown }; createdWidgetId?: unknown }
  if (result.ok !== true || typeof result.board?.id !== 'string' || typeof result.createdWidgetId !== 'string' || !result.board.id || !result.createdWidgetId || result.board.id.length > 100 || result.createdWidgetId.length > 100) return null
  return { boardId: result.board.id, widgetId: result.createdWidgetId }
}

export default function BoardChatPreview({ sessionId, boardId, widgetId }: { sessionId: string; boardId: string; widgetId: string }) {
  const navigate = useNavigate()
  const zh = useAppStore(state => state.language) === 'zh'
  const [result, setResult] = useState<Preview | null>(null)
  useEffect(() => {
    let alive = true
    setResult(null)
    const api = window.electronAPI as typeof window.electronAPI & Partial<PreviewApi>
    if (!api.getChatBoardPreview) { setResult({ ok: false, error: 'unavailable' }); return () => { alive = false } }
    void api.getChatBoardPreview({ sessionId, boardId, widgetId }).then(value => { if (alive) setResult(value) }).catch(() => { if (alive) setResult({ ok: false, error: 'unavailable' }) })
    return () => { alive = false }
  }, [sessionId, boardId, widgetId])
  const open = () => navigate(`/boards?${new URLSearchParams({ board: boardId, widget: widgetId }).toString()}`)
  return <section aria-label={zh ? '看板预览' : 'Board preview'} className="mt-3 overflow-hidden rounded-xl border border-line bg-ink-850">
    <div className="flex flex-wrap items-center justify-between gap-2 p-3">
      <div className="min-w-0"><p className="text-[13px] font-semibold text-cream">{result?.ok ? result.widgetTitle : (zh ? '看板组件' : 'Board component')}</p>{result?.ok && <p className="text-[12px] text-cream-faint">{result.boardName}</p>}</div>
      <button type="button" onClick={open} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream">{zh ? '打开看板' : 'Open board'}</button>
    </div>
    {result?.ok && <p className="px-3 pb-2 text-[11px] text-cream-faint">{result.source === 'file' ? (zh ? '文件静态预览；内容未经快照校验。' : 'Static file preview; content has not been verified against a snapshot.') : (zh ? '固定日期快照，不会自动刷新。' : 'Fixed-date snapshot; it does not refresh automatically.')}</p>}
    {!result && <p role="status" className="px-3 pb-3 text-[12px] text-cream-faint">{zh ? '正在读取已保存的组件…' : 'Loading saved component…'}</p>}
    {result && !result.ok && <p role="status" className="px-3 pb-3 text-[12px] text-cream-faint">{zh ? '此组件暂无对话预览，可打开看板查看。' : 'Preview unavailable. Open the board to view it.'}</p>}
    {result?.ok && <iframe title={zh ? '已保存的看板预览' : 'Saved board preview'} sandbox="" srcDoc={result.html} className="block h-[420px] w-full border-0 bg-white" />}
  </section>
}
