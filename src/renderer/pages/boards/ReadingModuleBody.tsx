import { useEffect, useRef, useState } from 'react'
import type { BoardWidget } from '@shared/types'
import { renderHtmlBoard, type HtmlBoardDocument } from '@shared/htmlBoard'
import { validateReadingSnapshot } from '@shared/readingSnapshot'
import { useAppStore } from '../../store'
import { HtmlBoardEditor } from './HtmlBoardEditor'
import { HtmlFilePreview } from './HtmlFilePreview'

/** An independently editable view backed by a Main-validated immutable snapshot. */
export function ReadingModuleBody({ widget, boardId, autoOpenAi = false, onAiOpened }: { widget: BoardWidget; boardId: string; autoOpenAi?: boolean; onAiOpened?: () => void }) {
  const language = useAppStore(state => state.language) === 'en' ? 'en' : 'zh'
  const selectedModel = useAppStore(state => state.pendingModel || state.modelConfig?.defaultModel || '')
  const zh = language === 'zh'
  const [saved, setSaved] = useState<HtmlBoardDocument | null>(null)
  const [editor, setEditor] = useState<HtmlBoardDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const sequence = useRef(0)
  const opened = useRef(false)
  const snapshot = validateReadingSnapshot(widget.config.snapshot)
  const load = async () => {
    const n = ++sequence.current
    setStatus(null)
    try {
      const result = await window.electronAPI.findHtmlBoardForReading({ boardId, widgetId: widget.id, language })
      if (n !== sequence.current) return
      if (result.ok) setSaved(result.document)
      else setStatus(zh ? '模块暂时无法读取，请重试。' : 'Could not load this module. Retry.')
    } catch { if (n === sequence.current) setStatus(zh ? '模块暂时无法读取，请重试。' : 'Could not load this module. Retry.') }
  }
  useEffect(() => { setSaved(null); void load(); return () => { sequence.current++ } }, [boardId, widget.id, language])
  const edit = async () => {
    if (busy) return
    setBusy(true); setStatus(null)
    try {
      const result = await window.electronAPI.loadOrCreateHtmlBoard({ boardId, widgetId: widget.id, language })
      if (result.ok) { sequence.current++; setSaved(result.document); setEditor(result.document) }
      else setStatus(zh ? '无法打开编辑器，请重试。' : 'Could not open the editor. Retry.')
    } catch { setStatus(zh ? '无法打开编辑器，请重试。' : 'Could not open the editor. Retry.') }
    finally { setBusy(false) }
  }
  useEffect(() => { if (autoOpenAi && !opened.current) { opened.current = true; void edit().finally(() => onAiOpened?.()) } }, [autoOpenAi, boardId, widget.id])
  const exportFile = async () => {
    if (busy) return
    setBusy(true); setStatus(null)
    try {
      const doc = await window.electronAPI.loadOrCreateHtmlBoard({ boardId, widgetId: widget.id, language })
      if (!doc.ok) { setStatus(zh ? '导出失败，请重试。' : 'Export failed. Retry.'); return }
      sequence.current++; setSaved(doc.document)
      const result = await window.electronAPI.exportHtmlBoard({ id: doc.document.id, expectedRevision: doc.document.revision, anonymize: true, language })
      if (result.ok) setStatus(zh ? '已导出。' : 'Exported.')
      else if (result.error !== 'cancelled') setStatus(zh ? '导出失败，请重试。' : 'Export failed. Retry.')
    } catch { setStatus(zh ? '导出失败，请重试。' : 'Export failed. Retry.') }
    finally { setBusy(false) }
  }
  if (!snapshot) return <p role="alert">{zh ? '快照无法读取。' : 'Snapshot could not be read.'}</p>
  let rendered: string | null = null
  try { if (saved) rendered = renderHtmlBoard(saved, { anonymize: false, language }) } catch { /* show a retry below */ }
  const toolbar = <><button type="button" disabled={busy} onClick={() => void edit()} className="focus-ring rounded-full border border-line px-2 py-1 text-cream-dim disabled:opacity-40">{zh ? '编辑模块' : 'Edit module'}</button><button type="button" disabled={busy || !saved} onClick={() => void exportFile()} className="focus-ring rounded-full border border-line px-2 py-1 text-cream-dim disabled:opacity-40">{zh ? '导出' : 'Export'}</button></>
  return <div className="flex h-full min-h-0 flex-col gap-1">
    {rendered ? <div className="min-h-0 flex-1"><HtmlFilePreview html={rendered} title={widget.title} language={language} allowScripts={false} compact toolbarActions={toolbar} /></div> : <><div className="flex shrink-0 flex-wrap items-center gap-1 text-[11px]">{toolbar}</div><div role="status" className="flex min-h-0 flex-1 items-center gap-2 text-[11px] text-cream-faint">{saved ? (zh ? '模块无法显示。' : 'Could not display this module.') : status ?? (zh ? '正在加载…' : 'Loading…')}<button type="button" onClick={() => void load()} className="focus-ring rounded border border-line px-2 py-1">{zh ? '重试' : 'Retry'}</button></div></>}
    {status && rendered && <p role="status" className="shrink-0 text-[11px] text-cream-faint">{status}</p>}
    {editor && <HtmlBoardEditor document={editor} language={language} onSave={async input => { const result = await window.electronAPI.saveHtmlBoard(input); if (result.ok) { sequence.current++; setSaved(result.document) }; return result }} onExport={input => window.electronAPI.exportHtmlBoard(input)} onGenerate={input => window.electronAPI.generateHtmlBoardEdit({ ...input, ...(selectedModel.includes('/') ? { modelSelector: selectedModel } : {}) })} onCancel={requestId => window.electronAPI.cancelHtmlBoardEdit(requestId)} onClose={() => setEditor(null)} />}
  </div>
}
