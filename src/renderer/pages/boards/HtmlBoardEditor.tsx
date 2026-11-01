import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { htmlBoardTemplate, readHtmlBoardBasicFields, renderHtmlBoard, updateHtmlBoardBasicField, type HtmlBoardBasicFields, type HtmlBoardDocument, type HtmlBoardDocumentResult, type HtmlBoardExportInput, type HtmlBoardExportResult, type HtmlBoardLanguage, type HtmlBoardSaveInput, type HtmlBoardTemplate } from '@shared/htmlBoard'
import { useModalBoundary } from '../../lib/modalBoundary'

export interface HtmlBoardEditorProps {
  document: HtmlBoardDocument
  language?: HtmlBoardLanguage
  onSave: (input: HtmlBoardSaveInput) => Promise<HtmlBoardDocumentResult>
  onExport: (input: HtmlBoardExportInput) => Promise<HtmlBoardExportResult>
  onGenerate: (input: { id: string; expectedRevision: number; instruction: string; requestId: string }) => Promise<HtmlBoardAiResult>
  onCancel: (requestId: string) => Promise<boolean>
  onClose: () => void
}
export type HtmlBoardAiResult = { ok: true; proposal: { html: string; css: string; theme: HtmlBoardTemplate; baseRevision: number } } | { ok: false; error: string }

// Keep an interrupted instruction for reopening this local document during the session.
const instructionDrafts = new Map<string, string>()

/** Edit display content around a protected, immutable reading snapshot. */
export function HtmlBoardEditor({ document: initial, language = 'zh', onSave, onExport, onGenerate, onCancel, onClose }: HtmlBoardEditorProps) {
  const zh = language !== 'en'
  const root = useRef<HTMLDivElement>(null)
  const [saved, setSaved] = useState(initial)
  const [html, setHtml] = useState(initial.html)
  const [css, setCss] = useState(initial.css)
  const [advanced, setAdvanced] = useState(false)
  const [theme, setTheme] = useState<HtmlBoardTemplate>(initial.theme ?? 'editorial')
  const [anonymous, setAnonymous] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingTemplate, setPendingTemplate] = useState<HtmlBoardTemplate | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [instruction, setInstruction] = useState(() => instructionDrafts.get(initial.id) ?? '')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiCancelling, setAiCancelling] = useState(false)
  const [aiNotice, setAiNotice] = useState<string | null>(null)
  const [proposal, setProposal] = useState<Extract<HtmlBoardAiResult, { ok: true }>['proposal'] | null>(null)
  const request = useRef<string | null>(null)
  const proposalSaveInProgress = useRef(false)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => () => { const id = request.current; request.current = null; if (id) void cancelRef.current(id).catch(() => {}) }, [])
  const dirty = html !== saved.html || css !== saved.css || theme !== (saved.theme ?? 'editorial')
  const editingLocked = busy || aiBusy || proposal !== null
  const basic = useMemo(() => readHtmlBoardBasicFields(html), [html])
  const updateInstruction = (value: string) => {
    setInstruction(value)
    if (value) {
      instructionDrafts.delete(saved.id)
      instructionDrafts.set(saved.id, value)
      if (instructionDrafts.size > 100) instructionDrafts.delete(instructionDrafts.keys().next().value!)
    } else instructionDrafts.delete(saved.id)
  }
  const close = () => {
    if (dirty || proposal) { setConfirmClose(true); return }
    const id = request.current
    request.current = null
    if (id) void cancelRef.current(id).catch(() => {})
    onClose()
  }
  useModalBoundary(root, true, close)
  const preview = useMemo(() => {
    try { return { html: renderHtmlBoard({ ...saved, html: proposal?.html ?? html, css: proposal?.css ?? css, theme: proposal?.theme ?? theme }, { anonymize: anonymous, language }), error: null } }
    catch { return { html: null, error: zh ? '预览失败：保留一个顶层数据占位符，移除脚本、外链、样式属性和不支持的 CSS 后重试。' : 'Cannot preview: keep one top-level data slot and remove scripts, external links, inline styles, and unsupported CSS.' } }
  }, [saved, html, css, theme, proposal, anonymous, language, zh])
  const generation = async () => {
    const prompt = instruction
    if (!prompt.trim() || dirty || busy || aiBusy || proposal || pendingTemplate || confirmClose) return
    const requestId = crypto.randomUUID()
    request.current = requestId
    setAiBusy(true); setAiCancelling(false); setAiNotice(null)
    try {
      const result = await onGenerate({ id: saved.id, expectedRevision: saved.revision, instruction: prompt, requestId })
      if (request.current !== requestId) return
      if (!result.ok) {
        setAiNotice(result.error === 'cancelled' ? (zh ? '已取消，修改说明仍保留。' : 'Cancelled. Your description is preserved.') : result.error === 'conflict' ? (zh ? '看板已在其他窗口更改，请重新打开后重试。' : 'This board changed in another window. Reopen it before retrying.') : result.error === 'sensitive-content' ? (zh ? '检测到可能的密钥或 Cookie，请检查说明和布局后重试。' : 'Possible credential or cookie detected. Check your description and layout, then retry.') : (zh ? '生成失败，请检查模型连接并重试；修改说明仍保留。' : 'Could not generate. Check the model connection and retry; your description is preserved.'))
        return
      }
      try {
        if (result.proposal.baseRevision !== saved.revision) throw new Error('revision')
        renderHtmlBoard({ ...saved, html: result.proposal.html, css: result.proposal.css, theme: result.proposal.theme }, { anonymize: true, language })
        setProposal(result.proposal)
      } catch { setAiNotice(zh ? '生成结果无法安全预览，请调整描述后重试。' : 'The result cannot be safely previewed. Adjust your description and retry.') }
    } catch { if (request.current === requestId) setAiNotice(zh ? '生成失败，请重试；修改说明仍保留。' : 'Generation failed. Retry; your description is preserved.') }
    finally { if (request.current === requestId) { request.current = null; setAiBusy(false); setAiCancelling(false) } }
  }
  const cancelGeneration = async () => {
    const id = request.current
    if (!id || aiCancelling) return
    setAiCancelling(true)
    try {
      if (!await onCancel(id) && request.current === id) { setAiCancelling(false); setAiNotice(zh ? '暂时无法取消，请等待本次生成结束。' : 'Could not cancel; please wait for this request to finish.') }
    } catch { if (request.current === id) { setAiCancelling(false); setAiNotice(zh ? '暂时无法取消，请等待本次生成结束。' : 'Could not cancel; please wait for this request to finish.') } }
  }
  const acceptProposal = async () => {
    if (!proposal || dirty || busy || aiBusy || proposalSaveInProgress.current || proposal.baseRevision !== saved.revision || !preview.html) return
    proposalSaveInProgress.current = true
    setBusy(true); setNotice(null); setAiNotice(null)
    try {
      const result = await onSave({ id: saved.id, expectedRevision: proposal.baseRevision, html: proposal.html, css: proposal.css, theme: proposal.theme })
      if (result.ok) {
        setSaved(result.document); setHtml(result.document.html); setCss(result.document.css); setTheme(result.document.theme ?? 'editorial'); setProposal(null); setConfirmClose(false)
        setNotice(zh ? '已采用并保存。' : 'Suggestion applied and saved.')
      } else setAiNotice(result.error === 'conflict' ? (zh ? '看板已在其他窗口更改，本方案未覆盖原内容；请重新打开后重试。' : 'This board changed in another window. The suggestion did not overwrite it; reopen and retry.') : (zh ? '保存失败，建议仍保留，请重试。' : 'Save failed. The suggestion is preserved; try again.'))
    } catch { setAiNotice(zh ? '保存失败，建议仍保留，请重试。' : 'Save failed. The suggestion is preserved; try again.') }
    finally { proposalSaveInProgress.current = false; setBusy(false) }
  }
  const applyTemplate = (id: HtmlBoardTemplate) => {
    const next = htmlBoardTemplate(id, language)
    setHtml(next.html); setCss(next.css); setTheme(id); setAdvanced(false); setPendingTemplate(null); setNotice(null)
  }
  const setBasic = (field: keyof HtmlBoardBasicFields, value: string) => {
    const next = updateHtmlBoardBasicField(html, field, value)
    if (next === null) { setNotice(zh ? '当前布局不支持这项修改，原内容已保留。' : 'This layout does not support that edit. Your original content is preserved.'); return }
    setHtml(next); setNotice(null)
  }
  const save = async () => {
    if (editingLocked || !dirty || !preview.html) return
    setBusy(true); setNotice(null)
    try {
      const result = await onSave({ id: saved.id, expectedRevision: saved.revision, html, css, theme })
      if (result.ok) { setSaved(result.document); setHtml(result.document.html); setCss(result.document.css); setTheme(result.document.theme ?? 'editorial'); setNotice(zh ? '已保存。' : 'Saved.') }
      else setNotice(result.error === 'conflict' ? (zh ? '看板已在其他窗口更改，请关闭后重新打开并检查未保存内容。' : 'This board changed in another window. Reopen it and review your unsaved changes.') : (zh ? '保存失败，请检查内容后重试。' : 'Save failed. Check the content and try again.'))
    } catch { setNotice(zh ? '保存失败，请重试。' : 'Save failed. Try again.') }
    finally { setBusy(false) }
  }
  const exportFile = async () => {
    if (editingLocked || dirty || !preview.html) return
    setBusy(true); setNotice(null)
    try {
      const result = await onExport({ id: saved.id, expectedRevision: saved.revision, anonymize: anonymous, language })
      if (result.ok) setNotice(zh ? '已导出离线 HTML 文件。' : 'Offline HTML exported.')
      else if (result.error !== 'cancelled') setNotice(result.error === 'conflict' ? (zh ? '看板已在其他窗口更改，请重新打开。' : 'This board changed in another window. Reopen it.') : (zh ? '导出失败，请重试。' : 'Export failed. Try again.'))
    } catch { setNotice(zh ? '导出失败，请重试。' : 'Export failed. Try again.') }
    finally { setBusy(false) }
  }
  const names: Record<HtmlBoardTemplate, string> = { editorial: zh ? '周报' : 'Editorial', operations: zh ? '巡检' : 'Operations', minimal: zh ? '简约' : 'Minimal' }
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3">
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby="html-board-editor-title" tabIndex={-1} className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[1320px] flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4"><div><h2 id="html-board-editor-title" className="text-[16px] font-semibold text-cream">{zh ? '自定义读数看板' : 'Customize reading board'}</h2><p className="text-[12px] text-cream-faint">{zh ? '静态快照；样式和文字可编辑，原始读数不可改写。' : 'Static snapshot; edit text and style without changing the source readings.'}</p></div><button type="button" onClick={close} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim">{zh ? '关闭' : 'Close'}</button></header>
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 lg:grid-cols-2">
        <section className="min-w-0 space-y-3"><div className="rounded-xl border border-line bg-overlay p-3"><h3 className="text-[14px] font-medium text-cream">{zh ? '告诉投手怎么改' : 'Describe the changes'}</h3><p className="mt-1 text-[12px] text-cream-faint">{zh ? '写下想要的风格或布局，先预览，再决定是否采用。若首次结果格式不受支持，可能自动修复一次并额外消耗模型 token。' : 'Describe the style or layout, then review the suggestion. If the first result has an unsupported format, one automatic retry may use extra model tokens.'}</p><label className="mt-2 block text-[12px] text-cream-dim">{zh ? '修改说明' : 'Change description'}<textarea aria-label={zh ? '修改说明' : 'Change description'} value={instruction} onChange={event => { updateInstruction(event.target.value); setAiNotice(null) }} maxLength={1200} disabled={aiBusy || proposal !== null || busy} placeholder={zh ? '例如：做成清晰的客户周报，突出结论和下一步' : 'For example: create a clear client report with conclusions and next steps'} className="mt-1 min-h-20 w-full rounded-lg border border-line bg-ink-900 p-3 text-[13px] text-cream disabled:opacity-60" /></label><div className="mt-2 flex flex-wrap gap-2">{(zh ? ['简洁客户周报', '突出重点和下一步', '更有设计感'] : ['Clear client report', 'Highlight priorities and next steps', 'More visual polish']).map(prompt => <button key={prompt} type="button" disabled={aiBusy || proposal !== null || busy} onClick={() => { updateInstruction(prompt); setAiNotice(null) }} className="focus-ring rounded-full border border-line px-2.5 py-1 text-[12px] text-cream-dim disabled:opacity-40">{prompt}</button>)}</div><p className="mt-2 text-[12px] text-cream-faint">{zh ? '你的描述、当前布局和所选读数（最多 50 个账户，包括账户名称、ID、数值和日期）会发送给所选模型。请勿在描述中粘贴密钥。' : 'Your description, current layout and selected readings (up to 50 accounts, including account names, IDs, figures and dates) are sent to the selected model. Do not paste credentials into your description.'}</p>{dirty && <p role="status" className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">{zh ? '请先保存当前修改，再生成新方案。' : 'Save your current changes before generating a suggestion.'}</p>}<div className="mt-2 flex flex-wrap gap-2">{aiBusy ? <button type="button" onClick={() => void cancelGeneration()} disabled={aiCancelling} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim disabled:opacity-40">{aiCancelling ? (zh ? '正在取消…' : 'Cancelling…') : (zh ? '取消生成' : 'Cancel generation')}</button> : <button type="button" onClick={() => void generation()} disabled={!instruction.trim() || dirty || busy || proposal !== null || !!pendingTemplate || confirmClose} className="focus-ring rounded-full bg-accent px-3 py-1.5 text-[12px] text-white disabled:opacity-40">{zh ? '生成修改建议' : 'Generate suggestion'}</button>}</div>{aiBusy && <p role="status" className="mt-2 text-[12px] text-cream-dim">{zh ? '正在生成建议…' : 'Generating suggestion…'}</p>}{aiNotice && <p role="status" className="mt-2 text-[12px] text-cream-dim">{aiNotice}</p>}</div><div className="flex flex-wrap items-center gap-2"><span className="text-[12px] text-cream-faint">{zh ? '读数区样式' : 'Report style'}</span>{(Object.keys(names) as HtmlBoardTemplate[]).map(id => <button key={id} type="button" aria-pressed={theme === id} disabled={editingLocked} onClick={() => { setTheme(id); setNotice(null) }} className={`focus-ring rounded-full border px-3 py-1 text-[12px] text-cream-dim disabled:opacity-40 ${theme === id ? 'border-accent bg-accent-soft' : 'border-line'}`}>{names[id]}</button>)}</div><p className="text-[12px] text-cream-faint">{zh ? '切换读数区配色和字体，不改变数据或自定义内容。' : 'Change report colors and typography without altering data or custom content.'}</p><div className="flex flex-wrap items-center gap-2"><span className="text-[12px] text-cream-faint">{zh ? '应用布局模板' : 'Apply layout template'}</span>{(Object.keys(names) as HtmlBoardTemplate[]).map(id => <button key={id} type="button" disabled={editingLocked} onClick={() => dirty ? setPendingTemplate(id) : applyTemplate(id)} className="focus-ring rounded-full border border-line px-3 py-1 text-[12px] text-cream-dim disabled:opacity-40">{names[id]}</button>)}</div>
          {pendingTemplate && <div role="alert" className="rounded-lg border border-amber-500/40 p-2 text-[12px] text-cream"><p>{zh ? '应用模板会替换当前未保存的 HTML 和 CSS。' : 'Applying a template replaces your unsaved HTML and CSS.'}</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => applyTemplate(pendingTemplate)} className="focus-ring rounded border border-line px-2 py-1">{zh ? '替换' : 'Replace'}</button><button type="button" onClick={() => setPendingTemplate(null)} className="focus-ring rounded border border-line px-2 py-1">{zh ? '取消' : 'Cancel'}</button></div></div>}
          {basic && <div className="space-y-3"><label className="block text-[12px] text-cream-dim">{zh ? '看板标题' : 'Board title'}<input aria-label={zh ? '看板标题' : 'Board title'} value={basic.title} onChange={event => setBasic('title', event.target.value)} maxLength={2000} disabled={editingLocked} className="mt-1 w-full rounded-lg border border-line bg-ink-900 p-3 text-[13px] text-cream" /></label><label className="block text-[12px] text-cream-dim">{zh ? '本期说明' : 'Period summary'}<textarea aria-label={zh ? '本期说明' : 'Period summary'} value={basic.summary} onChange={event => setBasic('summary', event.target.value)} maxLength={2000} disabled={editingLocked} className="mt-1 min-h-20 w-full rounded-lg border border-line bg-ink-900 p-3 text-[13px] text-cream" /></label><label className="block text-[12px] text-cream-dim">{zh ? '下一步' : 'Next steps'}<textarea aria-label={zh ? '下一步' : 'Next steps'} value={basic.nextSteps} onChange={event => setBasic('nextSteps', event.target.value)} maxLength={2000} disabled={editingLocked} className="mt-1 min-h-20 w-full rounded-lg border border-line bg-ink-900 p-3 text-[13px] text-cream" /></label></div>}
          {!basic && <p role="status" className="text-[12px] text-cream-faint">{zh ? '当前布局已保留，可以描述想要的修改，或打开高级编辑。' : 'Your custom layout is preserved. Describe changes or open advanced editing.'}</p>}
          <button type="button" aria-expanded={advanced} disabled={editingLocked} onClick={() => setAdvanced(!advanced)} className="focus-ring rounded-full border border-line px-3 py-1 text-[12px] text-cream-dim disabled:opacity-60">{advanced ? (zh ? '收起高级编辑' : 'Hide advanced editing') : (zh ? '高级编辑：HTML / CSS' : 'Advanced: HTML / CSS')}</button>
          {advanced && <div className="space-y-3"><p className="text-[12px] leading-5 text-cream-faint">{zh ? '保留一个顶层 <div data-reading-slot></div>。允许常用 HTML 标签、类名和受限 CSS；不支持脚本、链接、图片或外部资源。自定义 HTML/CSS 的文本、属性和注释不会自动脱敏。' : 'Keep one top-level <div data-reading-slot></div>. Common HTML and scoped CSS are supported; scripts, links, images and external resources are not. Custom HTML/CSS text, attributes and comments are not automatically anonymized.'}</p><label className="block text-[12px] text-cream-dim">HTML<textarea aria-label="HTML" spellCheck={false} value={html} onChange={event => { setHtml(event.target.value); setNotice(null) }} disabled={editingLocked} className="mt-1 min-h-48 w-full rounded-lg border border-line bg-ink-900 p-3 font-mono text-[12px] text-cream" /></label><label className="block text-[12px] text-cream-dim">CSS<textarea aria-label="CSS" spellCheck={false} value={css} onChange={event => { setCss(event.target.value); setNotice(null) }} disabled={editingLocked} className="mt-1 min-h-40 w-full rounded-lg border border-line bg-ink-900 p-3 font-mono text-[12px] text-cream" /></label></div>}
        </section>
        <section className="flex min-h-[360px] min-w-0 flex-col gap-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[13px] font-medium text-cream">{proposal ? (zh ? '建议预览' : 'Suggestion preview') : (zh ? '离线预览' : 'Offline preview')}</h3><label className="flex items-center gap-2 text-[12px] text-cream-dim"><input type="checkbox" checked={anonymous} onChange={event => setAnonymous(event.target.checked)} disabled={busy} />{zh ? '脱敏账户数据' : 'Anonymize account data'}</label></div><p className="text-[12px] text-cream-faint">{zh ? '账户名和 ID 默认脱敏；自定义内容和数值仍可能敏感，请分享前检查。' : 'Account names and IDs are anonymized by default. Custom content and values may still be sensitive; review before sharing.'}</p>{proposal && <div className="rounded-lg border border-line p-3 text-[12px] text-cream"><p role="status">{zh ? '建议尚未保存，请预览后选择采用或放弃。' : 'This suggestion is not saved. Review it before applying or discarding.'}</p>{aiNotice && <p role="alert" className="mt-2 text-red-500">{aiNotice}</p>}<div className="mt-2 flex gap-2"><button type="button" onClick={() => void acceptProposal()} disabled={busy} className="focus-ring rounded-full bg-accent px-3 py-1.5 text-white disabled:opacity-40">{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '采用并保存' : 'Apply and save')}</button><button type="button" disabled={busy} onClick={() => { setProposal(null); setAiNotice(zh ? '已放弃建议，原看板未更改。' : 'Suggestion discarded. The original board is unchanged.') }} className="focus-ring rounded-full border border-line px-3 py-1.5">{zh ? '放弃建议' : 'Discard suggestion'}</button></div></div>}{preview.html ? <iframe title={zh ? '自定义看板预览' : 'Custom board preview'} sandbox="" srcDoc={preview.html} className="min-h-[360px] w-full flex-1 rounded-lg border border-line bg-white" /> : <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-[12px] text-red-500">{preview.error}</p>}</section>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3"><div className="text-[12px] text-cream-faint" role="status">{notice ?? (proposal ? (zh ? '预览中；采用并保存后生效。' : 'Previewing; apply and save for the changes to take effect.') : dirty ? (zh ? '有未保存的修改；保存后才能导出。' : 'Unsaved changes; save before exporting.') : (zh ? '已保存。导出为本地静态文件，不会自动刷新或生成分享链接。' : 'Saved. Export is a local static file; it does not refresh or create a share link.'))}</div><div className="flex gap-2"><button type="button" onClick={() => void save()} disabled={editingLocked || !dirty || !preview.html} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream disabled:opacity-40">{zh ? '保存' : 'Save'}</button><button type="button" onClick={() => void exportFile()} disabled={editingLocked || dirty || !preview.html} className="focus-ring rounded-full bg-accent px-3 py-1.5 text-[12px] text-white disabled:opacity-40">{zh ? '导出 HTML' : 'Export HTML'}</button></div></footer>
      {confirmClose && <div role="alert" className="border-t border-amber-500/40 p-3 text-[12px] text-cream"><p>{busy ? (zh ? '操作可能仍会继续；尚未保存的修改或建议可能丢失。' : 'The operation may continue; unsaved changes or suggestions may be lost.') : (zh ? '有未保存的修改或建议，关闭会丢失它们。' : 'Closing will discard your unsaved changes or suggestion.')}</p><div className="mt-2 flex gap-2"><button type="button" onClick={onClose} className="focus-ring rounded border border-line px-2 py-1">{busy ? (zh ? '关闭' : 'Close') : (zh ? '放弃并关闭' : 'Discard and close')}</button><button type="button" onClick={() => setConfirmClose(false)} className="focus-ring rounded border border-line px-2 py-1">{zh ? '继续编辑' : 'Keep editing'}</button></div></div>}
    </div>
  </div>, globalThis.document.body)
}
