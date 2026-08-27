import { useEffect, useState } from 'react'
import { Check, LayoutDashboard, Loader2, X } from 'lucide-react'
import { KanbanBoard } from '@shared/types'
import { BOARD_LIMITS } from '@shared/boards'
import { useT } from '../i18n'

/**
 * Explicit chat → board handoff. The assistant cannot write a board by merely
 * producing text: the person picks a target board, reviews the note title,
 * and confirms this local save. Main re-reads and appends to the chosen board
 * atomically, so a stale dialog cannot overwrite recent board edits.
 */
export function SaveMessageToBoardDialog({
  content,
  onClose,
  onSaved
}: {
  content: string
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const [boards, setBoards] = useState<KanbanBoard[] | null>(null)
  const [boardId, setBoardId] = useState('')
  const [title, setTitle] = useState(t('boards.chat.noteTitle'))
  const [loadGeneration, setLoadGeneration] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setBoards(null)
    setLoadFailed(false)
    setError(null)
    void window.electronAPI
      .listBoards()
      .then((items) => {
        if (!alive) return
        setBoards(items)
        setBoardId((current) => current || items[0]?.id || '')
      })
      .catch(() => {
        if (!alive) return
        setBoards([])
        setLoadFailed(true)
      })
    return () => {
      alive = false
    }
  // Reload only when explicitly requested. Language changes do not need to rerun
  // an IPC read (and `useT` intentionally returns a render-local function).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadGeneration])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const save = async () => {
    if (!boardId || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.appendBoardNote({
        boardId,
        title: title.trim().slice(0, BOARD_LIMITS.maxWidgetTitleLength) || t('boards.chat.noteTitle'),
        text: content.slice(0, BOARD_LIMITS.maxNoteLength)
      })
      if (!result.ok) {
        setError(result.error === 'board-full' ? t('boards.chat.boardFull') : t('boards.chat.saveFailed'))
        if (result.error === 'not-found') setLoadGeneration((generation) => generation + 1)
        return
      }
      onSaved()
      onClose()
    } catch {
      setError(t('boards.chat.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const truncated = content.length > BOARD_LIMITS.maxNoteLength

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/75 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('boards.chat.dialogTitle')}
        className="w-full max-w-[420px] rounded-2xl border border-line bg-ink-900 p-5 shadow-pop"
      >
        <header className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <LayoutDashboard size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-cream">{t('boards.chat.dialogTitle')}</h2>
            {truncated && <p className="mt-1 text-[11px] leading-4 text-cream-faint">{t('boards.chat.trimmed')}</p>}
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            title={t('boards.cancel')}
            className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </header>

        {boards === null ? (
          <div className="mt-5 flex items-center gap-2 text-xs text-cream-dim">
            <Loader2 size={13} className="animate-spin text-accent" />
            {t('app.loading')}
          </div>
        ) : loadFailed ? (
          <div className="mt-5 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-xs leading-5 text-cream-dim">
            <p role="alert">{t('boards.chat.loadFailed')}</p>
            <button
              onClick={() => setLoadGeneration((generation) => generation + 1)}
              disabled={busy}
              className="mt-2 rounded-full border border-line px-3 py-1 text-[11px] text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
            >
              {t('boards.retry')}
            </button>
          </div>
        ) : boards.length === 0 ? (
          <p className="mt-5 rounded-xl border border-line bg-ink-850 px-3 py-2.5 text-xs leading-5 text-cream-dim">
            {t('boards.chat.noBoards')}
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-cream-faint">{t('boards.chat.pickBoard')}</span>
              <select
                value={boardId}
                onChange={(event) => setBoardId(event.target.value)}
                disabled={busy}
                className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream outline-none focus:border-accent/50 disabled:opacity-50"
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-cream-faint">{t('boards.chat.noteTitleLabel')}</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={BOARD_LIMITS.maxWidgetTitleLength}
                disabled={busy}
                className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream outline-none focus:border-accent/50 disabled:opacity-50"
              />
            </label>
          </div>
        )}

        {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}

        <footer className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
          >
            {t('boards.cancel')}
          </button>
          <button
            onClick={() => void save()}
            disabled={!boardId || busy}
            className="flex items-center gap-1 rounded-full bg-cream px-3 py-1.5 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
            {busy ? t('boards.chat.saving') : t('boards.chat.save')}
          </button>
        </footer>
      </section>
    </div>
  )
}
