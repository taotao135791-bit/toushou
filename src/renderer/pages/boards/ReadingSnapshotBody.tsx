import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BoardWidget } from '@shared/types'
import type { HtmlBoardDocument } from '@shared/htmlBoard'
import { renderHtmlBoard } from '@shared/htmlBoard'
import { validateReadingSnapshot } from '@shared/readingSnapshot'
import { buildBoardHighlightsPrompt } from '@shared/boardHighlights'
import { useAppStore } from '../../store'
import { startReadingAnalysis } from '../../lib/readingAnalysis'
import { ReadingSnapshotView } from './ReadingSnapshotView'
import { HtmlBoardEditor } from './HtmlBoardEditor'

/** Snapshot controls never send a model request; prompts are reviewed locally first. */
export function ReadingSnapshotBody({ widget, boardId, autoOpenAi = false, onAiOpened, showReadingSource = false }: { widget: BoardWidget; boardId: string; autoOpenAi?: boolean; onAiOpened?: () => void; showReadingSource?: boolean }) {
  const navigate = useNavigate()
  const language = useAppStore(state => state.language) === 'en' ? 'en' : 'zh'
  const selectedModel = useAppStore(state => state.pendingModel || state.modelConfig?.defaultModel || '')
  const zh = language === 'zh'
  const [anonymous, setAnonymous] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [document, setDocument] = useState<HtmlBoardDocument | null>(null)
  const [savedView, setSavedView] = useState<HtmlBoardDocument | null>(null)
  const [sourceView, setSourceView] = useState(showReadingSource)
  const loadSequence = useRef(0)
  useEffect(() => { if (showReadingSource) setSourceView(true) }, [showReadingSource])
  useEffect(() => {
    let alive = true
    const sequence = ++loadSequence.current
    setSavedView(null)
    void window.electronAPI.findHtmlBoardForReading({ boardId, widgetId: widget.id }).then(result => {
      if (!alive || sequence !== loadSequence.current) return
      if (result.ok) setSavedView(result.document)
      else if (result.error !== 'not-found') setStatus(zh ? '自定义布局暂时无法读取，原读数仍保留。请重试打开编辑器。' : 'Custom layout could not be loaded. Original readings are retained. Retry the editor.')
    }).catch(() => { if (alive && sequence === loadSequence.current) setStatus(zh ? '自定义布局暂时无法读取，请重试。' : 'Could not load the custom layout. Retry.') })
    return () => { alive = false; if (sequence === loadSequence.current) loadSequence.current++ }
  }, [boardId, widget.id, zh])
  const autoOpened = useRef(false)
  useEffect(() => { if (autoOpenAi && !autoOpened.current) { autoOpened.current = true; void customize().finally(() => onAiOpened?.()) } }, [autoOpenAi, boardId, widget.id])
  const snapshot = validateReadingSnapshot(widget.config.snapshot)
  const exportHtml = async () => {
    setBusy(true); setStatus(null)
    try {
      const result = savedView && !sourceView
        ? await window.electronAPI.exportHtmlBoard({ id: savedView.id, expectedRevision: savedView.revision, anonymize: anonymous, language })
        : await window.electronAPI.exportReadingSnapshot({ boardId, widgetId: widget.id, anonymize: anonymous, language })
      if (result.ok) setStatus(zh ? '已导出，可离线打开。' : 'Exported. Open the file offline.')
      else if (result.error !== 'cancelled') setStatus(zh ? '导出失败，请重试。' : 'Export failed. Try again.')
    } catch { setStatus(zh ? '导出失败，请重试。' : 'Export failed. Try again.') }
    finally { setBusy(false) }
  }
  const customize = async () => {
    setBusy(true); setStatus(null)
    try {
      const result = await window.electronAPI.loadOrCreateHtmlBoard({ boardId, widgetId: widget.id, language })
      if (result.ok) { loadSequence.current++; setDocument(result.document); setSavedView(result.document) }
      else setStatus(zh ? '无法打开 HTML 看板，请检查本地文件后重试。' : 'Could not open the HTML board. Check local storage and retry.')
    } catch { setStatus(zh ? '无法打开 HTML 看板，请重试。' : 'Could not open the HTML board. Retry.') }
    finally { setBusy(false) }
  }
  const reviewHighlights = async () => {
    setBusy(true); setStatus(null)
    try {
      const result = await window.electronAPI.getBoardHighlightEvidence({ boardId, widgetId: widget.id })
      if (result.ok) {
        const id = await startReadingAnalysis(buildBoardHighlightsPrompt(result.evidence, language))
        if (id) navigate('/')
        else setStatus(zh ? '未能开始分析，请检查模型连接后重试。' : 'Could not start analysis. Check your model connection and retry.')
      }
      else setStatus(zh ? '无法核对保存的读数，请重新打开看板。' : 'Could not verify saved readings. Reopen the board.')
    } catch { setStatus(zh ? '无法开始分析，请检查模型连接后重试。' : 'Could not start analysis. Check your model connection and retry.') }
    finally { setBusy(false) }
  }
  const buttonClass = 'focus-ring rounded-full border border-line px-3 py-1 disabled:opacity-40'
  if (!snapshot) return <p>{zh ? '快照无法读取。' : 'Snapshot could not be read.'}</p>
  let savedHtml: string | null = null
  let renderError = false
  try { if (savedView) savedHtml = renderHtmlBoard(savedView, { anonymize: false, language }) } catch { renderError = true }
  return <div className="flex h-full flex-col gap-3">
    <div className="flex flex-wrap items-center gap-3 text-[12px] text-cream-dim">
      <button type="button" disabled={busy} onClick={() => void customize()} className={buttonClass}>{zh ? '修改看板' : 'Edit board'}</button>
      {savedView && <button type="button" onClick={() => setSourceView(value => !value)} className={buttonClass}>{sourceView ? (zh ? '返回自定义布局' : 'Show saved layout') : (zh ? '查看原始读数' : 'View source readings')}</button>}
      <button type="button" disabled={busy} onClick={() => void reviewHighlights()} className={buttonClass}>{zh ? '分析与对话高光' : 'Analyze and highlight in chat'}</button>
      <label className="flex items-center gap-2"><input type="checkbox" checked={anonymous} onChange={e => setAnonymous(e.target.checked)} disabled={busy} />{zh ? '导出时脱敏账户信息' : 'Anonymize account information on export'}</label>
      <button type="button" disabled={busy || (renderError && !sourceView)} onClick={() => void exportHtml()} className={buttonClass}>{zh ? '导出 HTML' : 'Export HTML'}</button>
      {status && <span role="status">{status}</span>}
      {renderError && !sourceView && <span role="alert">{zh ? '保存的布局无法显示，原读数仍保留。请重试打开编辑器。' : 'The saved layout could not be displayed. Original readings are retained; retry the editor.'} <button type="button" disabled={busy} onClick={() => void customize()} className={buttonClass}>{zh ? '重试' : 'Retry'}</button></span>}
    </div>
    <div className="min-h-0 flex-1">{savedHtml && !sourceView ? <iframe title={zh ? '已保存的看板' : 'Saved board'} sandbox="" srcDoc={savedHtml} className="h-full min-h-[240px] w-full rounded border-0 bg-white" /> : <ReadingSnapshotView snapshot={snapshot} includeChart={widget.config.includeChart === true} language={language} />}</div>
    {document && <HtmlBoardEditor document={document} language={language} onSave={async input => { const result = await window.electronAPI.saveHtmlBoard(input); if (result.ok) { loadSequence.current++; setSavedView(result.document) }; return result }} onExport={input => window.electronAPI.exportHtmlBoard(input)} onGenerate={input => window.electronAPI.generateHtmlBoardEdit({ ...input, ...(selectedModel.includes('/') ? { modelSelector: selectedModel } : {}) })} onCancel={requestId => window.electronAPI.cancelHtmlBoardEdit(requestId)} onClose={() => setDocument(null)} />}
  </div>
}
