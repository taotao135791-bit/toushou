import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReadingSnapshot } from '@shared/readingSnapshot'
import type { KanbanBoard } from '@shared/types'
import { useModalBoundary } from '../../lib/modalBoundary'

export function SaveReadingBoardDialog({ snapshot, language, onClose, onSaved, initialAi = false }: {
  snapshot: ReadingSnapshot; language: 'zh' | 'en'; onClose: () => void; onSaved: (board: KanbanBoard, openAi?: boolean, widgetId?: string) => void; initialAi?: boolean
}) {
  const zh = language === 'zh'
  const ref = useRef<HTMLDivElement>(null)
  const loadSequence = useRef(0)
  const saving = useRef(false)
  const [name, setName] = useState(`${zh ? '读数' : 'Readings'} ${snapshot.window.start} – ${snapshot.window.end}`)
  const [destination, setDestination] = useState<'new' | 'existing'>('new')
  const [boards, setBoards] = useState<KanbanBoard[] | null>(null)
  const [boardId, setBoardId] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [chart, setChart] = useState(true)
  const [presentation, setPresentation] = useState<'modular' | 'report'>('modular')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useModalBoundary(ref, true, () => { if (!busy) onClose() })
  useEffect(() => () => { loadSequence.current++ }, [])
  const loadBoards = async () => {
    const sequence = ++loadSequence.current
    setLoading(true); setLoadFailed(false); setBoardId('')
    try {
      const result = await window.electronAPI.listBoards()
      if (sequence === loadSequence.current) setBoards(result)
    } catch { if (sequence === loadSequence.current) { setBoards(null); setLoadFailed(true) } }
    finally { if (sequence === loadSequence.current) setLoading(false) }
  }
  const selected = boards?.find(board => board.id === boardId && !board.locked)
  const save = async () => {
    if (busy || saving.current || (destination === 'new' && !name.trim()) || (destination === 'existing' && !selected)) return
    saving.current = true
    setBusy(true); setError(null)
    try {
      const result = await window.electronAPI.saveReadingSnapshot({ name: name.trim() || (zh ? '读数快照' : 'Reading snapshot'), snapshot, includeChart: chart, presentation, language,
        ...(destination === 'existing' && selected ? { target: { kind: 'existing' as const, boardId: selected.id, expectedUpdatedAt: selected.updatedAt } } : {}) })
      if (result.ok) onSaved(result.board, initialAi, result.focusWidgetId ?? result.widgetId)
      else { setError(result.error); setBusy(false) }
    } catch { setError('write-failed'); setBusy(false) }
    finally { saving.current = false }
  }
  const errorText = error === 'conflict' ? (zh ? '看板已发生变化，请刷新列表并重新选择。当前读数仍在。' : 'The board changed. Refresh the list and select it again; your readings remain available.')
    : error === 'board-locked' ? (zh ? '看板已锁定，请解锁或选择其他看板。' : 'The board is locked. Unlock it or choose another.')
      : error === 'board-full' ? (zh ? '看板已满，请选择其他看板。' : 'The board is full. Choose another.')
        : error === 'not-found' ? (zh ? '看板已不存在，请刷新列表并重新选择。' : 'The board no longer exists. Refresh the list and select another.')
          : (zh ? '保存失败，当前读数仍在。请重试。' : 'Save failed. Your readings are still available. Try again.')
  const dialog = <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="save-reading-title" className="w-full max-w-lg rounded-2xl border border-line bg-ink-850 p-5 shadow-card">
      <h2 id="save-reading-title" className="text-[16px] font-semibold text-cream">{zh ? '保存读数到看板' : 'Save readings to a board'}</h2>
      <p className="mt-2 text-[12px] leading-5 text-cream-dim">{zh ? '保存当前范围的读数、日期和读取状态。它是独立快照，之后刷新读数不会改写这份看板。' : 'Save this scope, dates and reading status as an independent snapshot. Later refreshes will not change this board.'}</p>
      <fieldset className="mt-4 flex flex-wrap gap-4 text-[13px] text-cream"><legend className="mb-2 text-[12px] text-cream-dim">{zh ? '保存位置' : 'Destination'}</legend>
        <label className="flex items-center gap-2"><input type="radio" name="reading-destination" checked={destination === 'new'} disabled={busy} onChange={() => { setDestination('new'); setError(null) }} />{zh ? '新建看板' : 'New board'}</label>
        <label className="flex items-center gap-2"><input type="radio" name="reading-destination" checked={destination === 'existing'} disabled={busy} onChange={() => { setDestination('existing'); setError(null); if (!boards && !loading) void loadBoards() }} />{zh ? '已有看板' : 'Existing board'}</label>
      </fieldset>
      {destination === 'new' ? <><label className="mt-4 block text-[12px] text-cream-dim" htmlFor="reading-board-name">{zh ? '看板名称' : 'Board name'}</label><input id="reading-board-name" autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={60} disabled={busy} className="mt-1 w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-[13px] text-cream" /></> : <div className="mt-4">
        <label className="block text-[12px] text-cream-dim" htmlFor="reading-board-existing">{zh ? '选择未锁定的看板' : 'Choose an unlocked board'}</label>
        <select id="reading-board-existing" value={boardId} disabled={busy || loading || loadFailed} onChange={event => { setBoardId(event.target.value); setError(null) }} className="mt-1 w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-[13px] text-cream"><option value="">{loading ? (zh ? '正在加载…' : 'Loading…') : (zh ? '请选择看板' : 'Select a board')}</option>{boards?.map(board => <option key={board.id} value={board.id} disabled={!!board.locked}>{board.name}{board.locked ? (zh ? '（已锁定）' : ' (locked)') : ''}</option>)}</select>
        {loadFailed && <p role="alert" className="mt-2 text-[12px] text-red-500">{zh ? '看板列表加载失败。' : 'Could not load boards.'}</p>}
        {!loading && !loadFailed && boards?.length === 0 && <p className="mt-2 text-[12px] text-cream-faint">{zh ? '暂无已有看板，可新建看板。' : 'No existing boards. Create a new one.'}</p>}
        <button type="button" onClick={() => void loadBoards()} disabled={busy || loading} className="focus-ring mt-2 rounded-full border border-line px-3 py-1 text-[12px] text-cream-dim disabled:opacity-40">{zh ? '刷新看板列表' : 'Refresh boards'}</button>
      </div>}
      <fieldset className="mt-4 flex flex-wrap gap-4 text-[13px] text-cream"><legend className="mb-2 text-[12px] text-cream-dim">{zh ? '看板形式' : 'Board layout'}</legend>
        <label className="flex items-center gap-2"><input type="radio" name="reading-presentation" checked={presentation === 'modular'} disabled={busy} onChange={() => setPresentation('modular')} />{zh ? '模块化看板' : 'Modular board'}</label>
        <label className="flex items-center gap-2"><input type="radio" name="reading-presentation" checked={presentation === 'report'} disabled={busy} onChange={() => setPresentation('report')} />{zh ? '整页报告' : 'Full report'}</label>
      </fieldset>
      <p className="mt-1 text-[12px] text-cream-faint">{presentation === 'modular' ? (zh ? '指标、说明和图表可分别拖动、调整大小与编辑；保留完整读数。' : 'Move, resize and edit metrics, notes and charts separately; the full snapshot is retained.') : (zh ? '以一个完整读数报告展示。' : 'Show one complete reading report.')}</p>
      <label className="mt-3 flex items-center gap-2 text-[13px] text-cream"><input type="checkbox" checked={chart} onChange={e => setChart(e.target.checked)} disabled={busy} />{zh ? '同时添加账户消耗可视化（可选）' : 'Include account spend visualization (optional)'}</label>
      <p className="mt-1 text-[12px] text-cream-faint">{zh ? '按平台和币种分别展示。失败或未知读数不会作为零计算。' : 'Grouped by platform and currency. Failed or unknown readings are not zero.'}</p>
      {error && <p role="alert" className="mt-3 text-[12px] text-red-600">{errorText}</p>}
      <div className="mt-5 flex justify-end gap-2"><button disabled={busy} onClick={onClose} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim">{zh ? '取消' : 'Cancel'}</button><button disabled={busy || (destination === 'new' && !name.trim()) || (destination === 'existing' && (!selected || loading || loadFailed))} onClick={() => void save()} className="focus-ring rounded-full bg-accent px-4 py-1.5 text-[12px] text-[rgb(var(--bg-app))] disabled:opacity-40">{busy ? (zh ? '保存中…' : 'Saving…') : (initialAi ? (zh ? '保存并用 AI 生成' : 'Save and create with AI') : (zh ? '保存并打开看板' : 'Save and open board'))}</button></div>
    </div>
  </div>
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
