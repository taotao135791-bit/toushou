import { describe, expect, it } from 'vitest'
import { groupSavedBoards, savedBoardReferences } from './SavedBoardDelivery'

const saved = { ok: true, board: { id: 'synthetic-board', name: 'Untrusted title', updatedAt: 5, widgets: [{ id: 'native-table', type: 'table' }, { id: 'native-funnel', type: 'funnel' }] }, createdWidgetId: 'native-table' }
const references = [{ boardId: 'synthetic-board', widgetId: 'native-table', revision: 5 }]

describe('native board delivery identities', () => {
  it('recognizes saved native create, add and atomic apply outputs without treating them as HTML', () => {
    expect(savedBoardReferences({ tool: 'toushou_board_create', input: {}, output: saved })).toEqual(references)
    expect(savedBoardReferences({ tool: 'write', input: { path: 'xd://toushou_board_add_widget', content: '{}' }, output: { content: [{ type: 'text', text: JSON.stringify(saved) }] } })).toEqual(references)
    expect(savedBoardReferences({ tool: 'toushou_board_customize', input: {}, output: { ...saved, applied: true } })).toEqual(references)
    expect(savedBoardReferences({ tool: 'toushou_board_build_commit', input: { buildId: 'build' }, output: { ...saved, draft: false, published: true } })).toEqual(references)
  })

  it('keeps every published board in a multi-board edit, including a board without components', () => {
    const output = {
      ok: true, published: true, draft: false,
      boards: [saved.board, { id: 'cleared-board', updatedAt: 6, widgets: [] }, { id: 'invalid\0' }]
    }
    expect(savedBoardReferences({ tool: 'toushou_board_build_commit', input: {}, output })).toEqual([
      ...references,
      { boardId: 'cleared-board', revision: 6 }
    ])
  })

  it('does not call a preview, failed write, guessed component, or ordinary text a saved board', () => {
    expect(savedBoardReferences({ tool: 'toushou_board_customize', input: {}, output: { ...saved, preview: true } })).toEqual([])
    expect(savedBoardReferences({ tool: 'toushou_board_create', input: {}, output: { ...saved, draft: true, published: false } })).toEqual([])
    expect(savedBoardReferences({ tool: 'toushou_board_build_commit', input: {}, output: { ...saved, ok: false, published: false } })).toEqual([])
    expect(savedBoardReferences({ tool: 'toushou_board_build_commit', input: {}, output: { ...saved, boards: [saved.board] } })).toEqual([])
    expect(savedBoardReferences({ tool: 'toushou_board_add_widget', input: {}, output: saved, isError: true })).toEqual([])
    expect(savedBoardReferences({ tool: 'toushou_board_add_widget', input: {}, output: { ...saved, ok: false } })).toEqual([])
    expect(savedBoardReferences({ tool: 'toushou_board_update_widget', input: { widgetId: 'missing' }, output: saved })).toEqual([])
    expect(savedBoardReferences({ tool: 'write', input: { path: 'xd://toushou_board_create/other' }, output: saved })).toEqual([])
    expect(savedBoardReferences({ tool: 'read', input: {}, output: saved })).toEqual([])
    expect(savedBoardReferences({ tool: 'toushou_board_create', input: {}, output: { ok: true, board: { id: 'synthetic-board' } } })).toEqual([])
    expect(savedBoardReferences({ tool: 'toushou_board_add_widget', input: {}, output: { ...saved, board: { ...saved.board, widgets: [{ id: 'native-table', type: 'file' }] } } })).toEqual([])
  })

  it('folds successive saved modules into one board result using the newest reference', () => {
    expect(groupSavedBoards([{ boardId: 'a', widgetId: 'one', revision: 1 }, { boardId: 'b', widgetId: 'other', revision: 2 }, { boardId: 'a', widgetId: 'two', revision: 3 }])).toEqual([{ boardId: 'a', widgetId: 'two', revision: 3 }, { boardId: 'b', widgetId: 'other', revision: 2 }])
  })
})
