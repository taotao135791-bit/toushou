import type { BoardNoteAppendRequest, BoardNoteAppendResult, KanbanBoard } from '@shared/types'
import { createBoard } from '@shared/boards'

type SaveInput = { title: string; text: string } & ({ kind: 'save'; boardId: string } | { kind: 'create'; name: string })
export type MessageBoardSaveError = 'create-failed' | 'save-failed' | 'board-full' | 'not-found'
type SaveApi = {
  saveBoard(board: KanbanBoard): Promise<{ ok: boolean }>
  appendBoardNote(input: BoardNoteAppendRequest): Promise<BoardNoteAppendResult>
}
type Callbacks = {
  onPending(kind: 'save' | 'create' | null): void
  onCreated(board: KanbanBoard): void
  onError(error: MessageBoardSaveError): void
  onSaved(): void
  onClose(): void
}

/** One local write at a time; closing/unmounting invalidates every late continuation. */
export function createMessageBoardSaver() {
  let active = true
  let pending = false
  let completed = false
  let generation = 0
  return {
    get pending() { return pending },
    get open() { return active && !completed },
    activate() { active = true; completed = false },
    dispose() { active = false; pending = false; generation += 1 },
    async run(input: SaveInput, api: SaveApi, callbacks: Callbacks): Promise<void> {
      if (!active || completed || pending) return
      pending = true
      const id = ++generation
      const current = () => active && generation === id
      callbacks.onPending(input.kind)
      let appending = input.kind === 'save'
      try {
        let boardId: string
        if (input.kind === 'create') {
          const board = createBoard(input.name.trim().slice(0, 60))
          const created = await api.saveBoard(board)
          if (!current()) return
          if (!created.ok) { callbacks.onError('create-failed'); return }
          // The board really exists, even if appending the note later fails.
          callbacks.onCreated(board)
          if (!current()) return
          boardId = board.id
          appending = true
        } else boardId = input.boardId
        const result = await api.appendBoardNote({ boardId, title: input.title, text: input.text })
        if (!current()) return
        if (!result.ok) {
          callbacks.onError(result.error === 'board-full' || result.error === 'not-found' ? result.error : 'save-failed')
          return
        }
        completed = true
        callbacks.onSaved()
        if (current()) callbacks.onClose()
      } catch {
        if (current() && !completed) callbacks.onError(appending ? 'save-failed' : 'create-failed')
      } finally {
        if (current()) { pending = false; callbacks.onPending(null) }
      }
    }
  }
}
