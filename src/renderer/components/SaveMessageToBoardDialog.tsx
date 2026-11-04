import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, LayoutDashboard, Loader2, X } from 'lucide-react'
import { KanbanBoard } from '@shared/types'
import { BOARD_LIMITS } from '@shared/boards'
import { useT } from '../i18n'
import { useModalBoundary } from '../lib/modalBoundary'
import { createMessageBoardSaver, type MessageBoardSaveError } from '../lib/messageBoardSave'

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
  const [operation, setOperation] = useState<'save' | 'create' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newBoardName, setNewBoardName] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const saverRef = useRef<ReturnType<typeof createMessageBoardSaver> | null>(null)
  if (!saverRef.current) saverRef.current = createMessageBoardSaver()
  const saver = saverRef.current
  const busy = operation === 'save'
  const creatingBoard = operation === 'create'
  const locked = busy || creatingBoard
  const hasDocument = typeof document !== 'undefined' && !!document.body

  useEffect(() => {
    saver.activate()
    return () => saver.dispose()
  }, [saver])

  const close = () => {
    if (saver.pending || !saver.open) return
    saver.dispose()
    onClose()
  }
  useModalBoundary(dialogRef, hasDocument, close)

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
        setBoardId((current) => items.some(board => board.id === current) ? current : items[0]?.id || '')
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

  const callbacks = {
    onPending: (kind: 'save' | 'create' | null) => { setOperation(kind); if (kind) setError(null) },
    onCreated: (board: KanbanBoard) => {
      setBoards(current => [...(current ?? []).filter(item => item.id !== board.id), board])
      setBoardId(board.id)
    },
    onError: (failure: MessageBoardSaveError) => {
      setError(failure === 'board-full' ? t('boards.chat.boardFull') : failure === 'create-failed' ? t('boards.chat.createFailed') : t('boards.chat.saveFailed'))
      if (failure === 'not-found') setLoadGeneration(generation => generation + 1)
    },
    onSaved,
    onClose
  }
  const note = () => ({
    title: title.trim().slice(0, BOARD_LIMITS.maxWidgetTitleLength) || t('boards.chat.noteTitle'),
    text: content.slice(0, BOARD_LIMITS.maxNoteLength)
  })
  const save = () => {
    if (!boardId || !boards?.some(board => board.id === boardId) || loadFailed || locked) return
    return saver.run({ kind: 'save', boardId, ...note() }, window.electronAPI, callbacks)
  }

  /**
   * Zero-board dead end fix: create a board in place, then save this note to
   * it — the user never has to leave the chat and lose the reply.
   */
  const createBoardAndSave = () => {
    const name = newBoardName.trim()
    if (!name || locked || boards === null || loadFailed || boards.length > 0) return
    return saver.run({ kind: 'create', name, ...note() }, window.electronAPI, callbacks)
  }

  const truncated = content.length > BOARD_LIMITS.maxNoteLength

  const dialog = (
    <div className="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={locked}
        className="dialog-panel flex max-h-[calc(100dvh-32px)] w-full max-w-[420px] flex-col overflow-hidden rounded-2xl border border-line bg-ink-900 shadow-pop"
      >
        <header className="flex shrink-0 items-start gap-2.5 border-b border-line px-5 py-4">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <LayoutDashboard size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[14px] font-semibold text-cream">{t('boards.chat.dialogTitle')}</h2>
            {truncated && <p className="mt-1 text-[11px] leading-4 text-cream-faint">{t('boards.chat.trimmed')}</p>}
          </div>
          <button
            type="button"
            onClick={close}
            disabled={locked}
            title={t('boards.cancel')}
            aria-label={t('boards.cancel')}
            className="focus-ring rounded-md p-1 text-cream-faint transition-colors hover:bg-overlay hover:text-cream disabled:cursor-wait disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {boards === null ? (
          <div role="status" className="flex items-center gap-2 text-xs text-cream-dim">
            <Loader2 size={13} className="animate-spin text-accent" />
            {t('app.loading')}
          </div>
        ) : loadFailed ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-xs leading-5 text-cream-dim">
            <p role="alert">{t('boards.chat.loadFailed')}</p>
            <button
              onClick={() => setLoadGeneration((generation) => generation + 1)}
              type="button"
              disabled={locked}
              className="focus-ring mt-2 rounded-full border border-line px-3 py-1 text-[11px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream disabled:opacity-50"
            >
              {t('boards.retry')}
            </button>
          </div>
        ) : boards.length === 0 ? (
          <div className="space-y-3">
            <p className="rounded-xl border border-line bg-ink-850 px-3 py-2.5 text-xs leading-5 text-cream-dim">
              {t('boards.chat.noBoards')}
            </p>
            <label className="block">
              <span className="mb-1 block text-[11px] text-cream-faint">{t('boards.chat.createBoardLabel')}</span>
              <input
                value={newBoardName}
                onChange={(event) => setNewBoardName(event.target.value)}
                maxLength={60}
                autoFocus
                disabled={locked}
                className="focus-ring min-h-9 w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream disabled:opacity-50"
              />
            </label>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-cream-faint">{t('boards.chat.pickBoard')}</span>
              <select
                value={boardId}
                onChange={(event) => setBoardId(event.target.value)}
                disabled={locked}
                className="focus-ring min-h-9 w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream disabled:opacity-50"
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
                disabled={locked}
                className="focus-ring min-h-9 w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream disabled:opacity-50"
              />
            </label>
          </div>
        )}

        {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
        </div>

        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-4">
          <button
            type="button"
            onClick={close}
            disabled={locked}
            className="focus-ring min-h-8 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream disabled:cursor-wait disabled:opacity-50"
          >
            {t('boards.cancel')}
          </button>
          {(boards?.length ?? 0) === 0 ? (
            <button
              onClick={() => void createBoardAndSave()}
              type="button"
              disabled={!newBoardName.trim() || locked || boards === null || loadFailed}
              className="focus-ring flex min-h-8 items-center gap-1 rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-ink-950 transition-colors hover:opacity-90 disabled:opacity-40"
            >
              {creatingBoard ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              {creatingBoard ? t('boards.chat.saving') : t('boards.chat.createAndSave')}
            </button>
          ) : (
            <button
              onClick={() => void save()}
              type="button"
              disabled={!boardId || locked || loadFailed}
              className="focus-ring flex min-h-8 items-center gap-1 rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-ink-950 transition-colors hover:opacity-90 disabled:opacity-40"
            >
              {locked ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              {locked ? t('boards.chat.saving') : t('boards.chat.save')}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
  return hasDocument ? createPortal(dialog, document.body) : dialog
}
