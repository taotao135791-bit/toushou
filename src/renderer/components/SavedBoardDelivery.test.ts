import { describe, expect, it } from 'vitest'
import { groupSavedBoards, savedBoardReference } from './SavedBoardDelivery'

const saved = { ok: true, board: { id: 'synthetic-board', name: 'Untrusted title', updatedAt: 5, widgets: [{ id: 'native-table', type: 'table' }, { id: 'native-funnel', type: 'funnel' }] }, createdWidgetId: 'native-table' }

describe('native board delivery identities', () => {
  it('recognizes saved native create, add and atomic apply outputs without treating them as HTML', () => {
    expect(savedBoardReference({ tool: 'toushou_board_create', input: {}, output: saved })).toEqual({ boardId: 'synthetic-board', widgetId: 'native-table', revision: 5 })
    expect(savedBoardReference({ tool: 'write', input: { path: 'xd://toushou_board_add_widget', content: '{}' }, output: { content: [{ type: 'text', text: JSON.stringify(saved) }] } })).toEqual({ boardId: 'synthetic-board', widgetId: 'native-table', revision: 5 })
    expect(savedBoardReference({ tool: 'toushou_board_customize', input: {}, output: { ...saved, applied: true } })).toEqual({ boardId: 'synthetic-board', widgetId: 'native-table', revision: 5 })
    expect(savedBoardReference({ tool: 'toushou_board_build_commit', input: { buildId: 'build' }, output: { ...saved, draft: false, published: true } })).toEqual({ boardId: 'synthetic-board', widgetId: 'native-table', revision: 5 })
  })

  it('does not call a preview, failed write, guessed component, or ordinary text a saved board', () => {
    expect(savedBoardReference({ tool: 'toushou_board_customize', input: {}, output: { ...saved, preview: true } })).toBeNull()
    expect(savedBoardReference({ tool: 'toushou_board_create', input: {}, output: { ...saved, draft: true, published: false } })).toBeNull()
    expect(savedBoardReference({ tool: 'toushou_board_build_commit', input: {}, output: { ...saved, ok: false, published: false } })).toBeNull()
    expect(savedBoardReference({ tool: 'toushou_board_add_widget', input: {}, output: saved, isError: true })).toBeNull()
    expect(savedBoardReference({ tool: 'toushou_board_add_widget', input: {}, output: { ...saved, ok: false } })).toBeNull()
    expect(savedBoardReference({ tool: 'toushou_board_update_widget', input: { widgetId: 'missing' }, output: saved })).toBeNull()
    expect(savedBoardReference({ tool: 'write', input: { path: 'xd://toushou_board_create/other' }, output: saved })).toBeNull()
    expect(savedBoardReference({ tool: 'read', input: {}, output: saved })).toBeNull()
    expect(savedBoardReference({ tool: 'toushou_board_create', input: {}, output: { ok: true, board: { id: 'synthetic-board' } } })).toBeNull()
    expect(savedBoardReference({ tool: 'toushou_board_add_widget', input: {}, output: { ...saved, board: { ...saved.board, widgets: [{ id: 'native-table', type: 'file' }] } } })).toBeNull()
  })

  it('folds successive saved modules into one board result using the newest reference', () => {
    expect(groupSavedBoards([{ boardId: 'a', widgetId: 'one', revision: 1 }, { boardId: 'b', widgetId: 'other', revision: 2 }, { boardId: 'a', widgetId: 'two', revision: 3 }])).toEqual([{ boardId: 'a', widgetId: 'two', revision: 3 }, { boardId: 'b', widgetId: 'other', revision: 2 }])
  })
})
