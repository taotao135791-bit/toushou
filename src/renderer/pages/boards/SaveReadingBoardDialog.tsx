import { useRef, useState } from 'react'
import type { ReadingSnapshot } from '@shared/readingSnapshot'
import type { KanbanBoard } from '@shared/types'
import { useModalBoundary } from '../../lib/modalBoundary'

export function SaveReadingBoardDialog({ snapshot, language, onClose, onSaved }: {
  snapshot: ReadingSnapshot; language: 'zh' | 'en'; onClose: () => void; onSaved: (board: KanbanBoard) => void
}) {
  const zh = language === 'zh'
  const ref = useRef<HTMLDivElement>(null)
  const [name, setName] = useState(`${zh ? '读数' : 'Readings'} ${snapshot.window.start} – ${snapshot.window.end}`)
  const [chart, setChart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useModalBoundary(ref, true, () => { if (!busy) onClose() })
  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true); setError(false)
    try {
      const result = await window.electronAPI.saveReadingSnapshot({ name: name.trim(), snapshot, includeChart: chart, language })
      if (result.ok) onSaved(result.board)
      else { setError(true); setBusy(false) }
    } catch { setError(true); setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="save-reading-title" className="w-full max-w-lg rounded-2xl border border-line bg-ink-850 p-5 shadow-card">
      <h2 id="save-reading-title" className="text-[16px] font-semibold text-cream">{zh ? '保存为新看板' : 'Save as a new board'}</h2>
      <p className="mt-2 text-[12px] leading-5 text-cream-dim">{zh ? '保存当前范围的读数、日期和读取状态。它是独立快照，之后刷新读数不会改写这份看板。' : 'Save this scope, dates and reading status as an independent snapshot. Later refreshes will not change this board.'}</p>
      <label className="mt-4 block text-[12px] text-cream-dim" htmlFor="reading-board-name">{zh ? '看板名称' : 'Board name'}</label>
      <input id="reading-board-name" autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={60} disabled={busy} className="mt-1 w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-[13px] text-cream" />
      <label className="mt-3 flex items-center gap-2 text-[13px] text-cream"><input type="checkbox" checked={chart} onChange={e => setChart(e.target.checked)} disabled={busy} />{zh ? '同时添加账户消耗可视化（可选）' : 'Include account spend visualization (optional)'}</label>
      <p className="mt-1 text-[12px] text-cream-faint">{zh ? '使用 HTML/CSS 绘制，按平台和币种分别展示。失败或未知读数不会作为零计算。' : 'Rendered with HTML/CSS, grouped by platform and currency. Failed or unknown readings are not zero.'}</p>
      {error && <p role="alert" className="mt-3 text-[12px] text-red-600">{zh ? '保存失败，当前读数仍在。请重试。' : 'Save failed. Your readings are still available. Try again.'}</p>}
      <div className="mt-5 flex justify-end gap-2"><button disabled={busy} onClick={onClose} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim">{zh ? '取消' : 'Cancel'}</button><button disabled={busy || !name.trim()} onClick={() => void save()} className="focus-ring rounded-full bg-accent px-4 py-1.5 text-[12px] text-[rgb(var(--bg-app))] disabled:opacity-40">{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存并打开看板' : 'Save and open board')}</button></div>
    </div>
  </div>
}
