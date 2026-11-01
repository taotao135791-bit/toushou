import { useState } from 'react'
import type { BoardWidget } from '@shared/types'
import type { HtmlBoardDocument } from '@shared/htmlBoard'
import { validateReadingSnapshot } from '@shared/readingSnapshot'
import { buildBoardHighlightsPrompt } from '@shared/boardHighlights'
import { useAppStore } from '../../store'
import { ReadingSnapshotView } from './ReadingSnapshotView'
import { ReadingDraftDialog } from './ReadingDraftDialog'
import { HtmlBoardEditor } from './HtmlBoardEditor'

/** Snapshot controls never send a model request; prompts are reviewed locally first. */
export function ReadingSnapshotBody({ widget, boardId }: { widget: BoardWidget; boardId: string }) {
  const language = useAppStore(state => state.language) === 'en' ? 'en' : 'zh'
  const zh = language === 'zh'
  const [anonymous, setAnonymous] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [document, setDocument] = useState<HtmlBoardDocument | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null)
  const snapshot = validateReadingSnapshot(widget.config.snapshot)
  if (!snapshot) return <p>{zh ? '快照无法读取。' : 'Snapshot could not be read.'}</p>
  const exportHtml = async () => {
    setBusy(true); setStatus(null)
    try {
      const result = await window.electronAPI.exportReadingSnapshot({ boardId, widgetId: widget.id, anonymize: anonymous, language })
      if (result.ok) setStatus(zh ? '已导出，可离线打开。' : 'Exported. Open the file offline.')
      else if (result.error !== 'cancelled') setStatus(zh ? '导出失败，请重试。' : 'Export failed. Try again.')
    } catch { setStatus(zh ? '导出失败，请重试。' : 'Export failed. Try again.') }
    finally { setBusy(false) }
  }
  const customize = async () => {
    setBusy(true); setStatus(null)
    try {
      const result = await window.electronAPI.loadOrCreateHtmlBoard({ boardId, widgetId: widget.id, language })
      if (result.ok) setDocument(result.document)
      else setStatus(zh ? '无法打开 HTML 看板，请检查本地文件后重试。' : 'Could not open the HTML board. Check local storage and retry.')
    } catch { setStatus(zh ? '无法打开 HTML 看板，请重试。' : 'Could not open the HTML board. Retry.') }
    finally { setBusy(false) }
  }
  const reviewHighlights = async () => {
    setBusy(true); setStatus(null)
    try {
      const result = await window.electronAPI.getBoardHighlightEvidence({ boardId, widgetId: widget.id })
      if (result.ok) { setDraft(buildBoardHighlightsPrompt(result.evidence, language)); setCopied(null) }
      else setStatus(zh ? '无法核对保存的读数，请重新打开看板。' : 'Could not verify saved readings. Reopen the board.')
    } catch { setStatus(zh ? '无法准备分析草稿，请重试。' : 'Could not prepare the analysis draft. Retry.') }
    finally { setBusy(false) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(draft ?? ''); setCopied('copied') }
    catch { setCopied('failed') }
  }
  const buttonClass = 'focus-ring rounded-full border border-line px-3 py-1 disabled:opacity-40'
  return <div className="flex h-full flex-col gap-3">
    <div className="flex flex-wrap items-center gap-3 text-[12px] text-cream-dim">
      <button type="button" disabled={busy} onClick={() => void customize()} className={buttonClass}>{zh ? '定制 HTML 看板' : 'Customize HTML board'}</button>
      <button type="button" disabled={busy} onClick={() => void reviewHighlights()} className={buttonClass}>{zh ? '分析与对话高光' : 'Analyze and highlight in chat'}</button>
      <label className="flex items-center gap-2"><input type="checkbox" checked={anonymous} onChange={e => setAnonymous(e.target.checked)} disabled={busy} />{zh ? '导出时脱敏账户信息' : 'Anonymize account information on export'}</label>
      <button type="button" disabled={busy} onClick={() => void exportHtml()} className={buttonClass}>{zh ? '导出 HTML' : 'Export HTML'}</button>
      {status && <span role="status">{status}</span>}
    </div>
    <div className="min-h-0 flex-1"><ReadingSnapshotView snapshot={snapshot} includeChart={widget.config.includeChart === true} language={language} /></div>
    {document && <HtmlBoardEditor document={document} language={language} onSave={input => window.electronAPI.saveHtmlBoard(input)} onExport={input => window.electronAPI.exportHtmlBoard(input)} onClose={() => setDocument(null)} />}
    {draft !== null && <ReadingDraftDialog title={zh ? '核对脱敏分析草稿' : 'Review anonymous analysis draft'} language={language} value={draft} copyState={copied} onChange={value => { setDraft(value); setCopied(null) }} onClose={() => setDraft(null)} onCopy={() => void copy()} />}
  </div>
}
