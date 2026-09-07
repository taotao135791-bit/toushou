import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from './index'

afterEach(() => {
  useAppStore.setState({ preUndoByTurnCheckpoint: {} })
})

/**
 * Redo targets for undone turns: Main mints a 'pre-undo' checkpoint on every
 * restore and returns its id; the store keeps turnCheckpointId -> id in
 * memory for the app session only (an entry exists exactly while the row is
 * undone and is cleared when a redo succeeds).
 */
describe('pre-undo redo targets', () => {
  it('records the redo target minted by an undo', () => {
    useAppStore.getState().setPreUndoForTurn('turn-1', 'pre-1')
    expect(useAppStore.getState().preUndoByTurnCheckpoint['turn-1']).toBe('pre-1')
  })

  it('replaces the target on a second undo (each undo snapshots afresh)', () => {
    useAppStore.getState().setPreUndoForTurn('turn-1', 'pre-1')
    useAppStore.getState().setPreUndoForTurn('turn-1', 'pre-2')
    expect(useAppStore.getState().preUndoByTurnCheckpoint['turn-1']).toBe('pre-2')
  })

  it('clears the target when a redo succeeds and keeps other turns untouched', () => {
    useAppStore.getState().setPreUndoForTurn('turn-1', 'pre-1')
    useAppStore.getState().setPreUndoForTurn('turn-2', 'pre-2')

    useAppStore.getState().setPreUndoForTurn('turn-1', null)

    expect(useAppStore.getState().preUndoByTurnCheckpoint).toEqual({ 'turn-2': 'pre-2' })
  })

  it('tolerates redundant writes and clearing a missing entry', () => {
    useAppStore.getState().setPreUndoForTurn('turn-1', 'pre-1')
    useAppStore.getState().setPreUndoForTurn('turn-1', 'pre-1')
    useAppStore.getState().setPreUndoForTurn('turn-x', null)
    expect(useAppStore.getState().preUndoByTurnCheckpoint).toEqual({ 'turn-1': 'pre-1' })
  })
})
