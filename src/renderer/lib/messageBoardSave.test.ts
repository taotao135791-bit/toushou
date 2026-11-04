import { describe, expect, it, vi } from 'vitest'
import { createBoard } from '@shared/boards'
import type { BoardNoteAppendResult, KanbanBoard } from '@shared/types'
import { createMessageBoardSaver } from './messageBoardSave'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const handlers = () => ({
  onPending: vi.fn(), onCreated: vi.fn(), onError: vi.fn(), onSaved: vi.fn(), onClose: vi.fn()
})
const note = { title: 'Synthetic summary', text: 'Synthetic note; no account data.' }

describe('chat to board writes', () => {
  it('accepts one in-flight save and cannot repeat a completed save before the dialog unmounts', async () => {
    const saver = createMessageBoardSaver()
    const pending = deferred<BoardNoteAppendResult>()
    const api = { saveBoard: vi.fn(), appendBoardNote: vi.fn(() => pending.promise) }
    const callbacks = handlers()
    const first = saver.run({ kind: 'save', boardId: 'synthetic-board', ...note }, api, callbacks)
    await saver.run({ kind: 'save', boardId: 'synthetic-board', ...note }, api, callbacks)
    expect(saver.pending).toBe(true)
    expect(api.appendBoardNote).toHaveBeenCalledTimes(1)
    expect(api.appendBoardNote).toHaveBeenCalledWith({ boardId: 'synthetic-board', ...note })
    expect(callbacks.onSaved).not.toHaveBeenCalled()
    pending.resolve({ ok: true, board: createBoard('Synthetic board') })
    await first
    await saver.run({ kind: 'save', boardId: 'synthetic-board', ...note }, api, callbacks)
    expect(api.appendBoardNote).toHaveBeenCalledTimes(1)
    expect(callbacks.onSaved).toHaveBeenCalledTimes(1)
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
    expect(callbacks.onPending.mock.calls).toEqual([['save'], [null]])
    expect(saver.pending).toBe(false)
  })

  it('does not create twice, then retries an append failure against the already-created board', async () => {
    const saver = createMessageBoardSaver()
    const pending = deferred<{ ok: boolean }>()
    const api = {
      saveBoard: vi.fn(() => pending.promise),
      appendBoardNote: vi.fn().mockRejectedValueOnce(new Error('synthetic write failure')).mockResolvedValueOnce({ ok: true, board: createBoard('Synthetic board') })
    }
    const callbacks = handlers()
    const first = saver.run({ kind: 'create', name: 'Synthetic board', ...note }, api, callbacks)
    await saver.run({ kind: 'create', name: 'Synthetic board', ...note }, api, callbacks)
    expect(api.saveBoard).toHaveBeenCalledTimes(1)
    expect(api.appendBoardNote).not.toHaveBeenCalled()
    pending.resolve({ ok: true })
    await first
    const board = callbacks.onCreated.mock.calls[0][0] as KanbanBoard
    expect(board.name).toBe('Synthetic board')
    expect(callbacks.onError).toHaveBeenCalledWith('save-failed')
    expect(callbacks.onSaved).not.toHaveBeenCalled()
    await saver.run({ kind: 'save', boardId: board.id, ...note }, api, callbacks)
    expect(api.saveBoard).toHaveBeenCalledTimes(1)
    expect(api.appendBoardNote).toHaveBeenNthCalledWith(2, { boardId: board.id, ...note })
    expect(callbacks.onSaved).toHaveBeenCalledTimes(1)
  })

  it('keeps failed board creation retryable without attempting an append', async () => {
    const saver = createMessageBoardSaver()
    const api = { saveBoard: vi.fn().mockResolvedValue({ ok: false }), appendBoardNote: vi.fn() }
    const callbacks = handlers()
    await saver.run({ kind: 'create', name: 'Synthetic board', ...note }, api, callbacks)
    expect(api.appendBoardNote).not.toHaveBeenCalled()
    expect(callbacks.onCreated).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith('create-failed')
    expect(saver.pending).toBe(false)
    expect(saver.open).toBe(true)
  })

  it.each(['not-found', 'board-full', 'write-failed'] as const)('preserves the relevant error and the draft after %s', async error => {
    const saver = createMessageBoardSaver()
    const api = { saveBoard: vi.fn(), appendBoardNote: vi.fn().mockResolvedValue({ ok: false, error }) }
    const callbacks = handlers()
    await saver.run({ kind: 'save', boardId: 'synthetic-board', ...note }, api, callbacks)
    expect(callbacks.onError).toHaveBeenCalledWith(error === 'write-failed' ? 'save-failed' : error)
    expect(callbacks.onSaved).not.toHaveBeenCalled()
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(saver.open).toBe(true)
  })

  it('does not append or update the closed UI when creation finishes after unmount', async () => {
    const saver = createMessageBoardSaver()
    const pending = deferred<{ ok: boolean }>()
    const api = { saveBoard: vi.fn(() => pending.promise), appendBoardNote: vi.fn() }
    const callbacks = handlers()
    const run = saver.run({ kind: 'create', name: 'Synthetic board', ...note }, api, callbacks)
    saver.dispose()
    pending.resolve({ ok: true })
    await run
    expect(api.appendBoardNote).not.toHaveBeenCalled()
    expect(callbacks.onCreated).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onSaved).not.toHaveBeenCalled()
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(callbacks.onPending.mock.calls).toEqual([['create']])
  })

  it('invalidates an earlier generation even if the effect is mounted again', async () => {
    const saver = createMessageBoardSaver()
    const pending = deferred<BoardNoteAppendResult>()
    const api = { saveBoard: vi.fn(), appendBoardNote: vi.fn(() => pending.promise) }
    const callbacks = handlers()
    const run = saver.run({ kind: 'save', boardId: 'synthetic-board', ...note }, api, callbacks)
    saver.dispose()
    saver.activate()
    pending.resolve({ ok: true, board: createBoard('Synthetic board') })
    await run
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onSaved).not.toHaveBeenCalled()
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(callbacks.onPending.mock.calls).toEqual([['save']])
  })

  it('does not start a second write if the owner unmounts immediately after creation', async () => {
    const saver = createMessageBoardSaver()
    const api = { saveBoard: vi.fn().mockResolvedValue({ ok: true }), appendBoardNote: vi.fn() }
    const callbacks = { ...handlers(), onCreated: vi.fn(() => saver.dispose()) }
    await saver.run({ kind: 'create', name: 'Synthetic board', ...note }, api, callbacks)
    expect(callbacks.onCreated).toHaveBeenCalledTimes(1)
    expect(api.appendBoardNote).not.toHaveBeenCalled()
    expect(callbacks.onSaved).not.toHaveBeenCalled()
  })
})
