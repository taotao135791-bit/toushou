import { describe, expect, it } from 'vitest'
import { boardPreviewReference } from './BoardChatPreview'

describe('saved board preview references', () => {
  const result = { ok: true, board: { id: 'synthetic-board' }, createdWidgetId: 'synthetic-widget' }
  it('accepts a successful board tool response as a reference, not HTML', () => {
    const ref = { boardId: 'synthetic-board', widgetId: 'synthetic-widget' }
    expect(boardPreviewReference({ tool: 'toushou_board_add_widget', input: {}, output: JSON.stringify(result) })).toEqual(ref)
    expect(boardPreviewReference({ tool: 'toushou_board_add_widget', input: {}, output: { content: [{ type: 'text', text: JSON.stringify(result) }] } })).toEqual(ref)
  })
  it('ignores failures, other tools, bad JSON and missing IDs', () => {
    expect(boardPreviewReference({ tool: 'toushou_board_add_widget', input: {}, output: JSON.stringify(result), isError: true })).toBeNull()
    expect(boardPreviewReference({ tool: 'write', input: {}, output: JSON.stringify(result) })).toBeNull()
    expect(boardPreviewReference({ tool: 'toushou_board_add_widget', input: {}, output: '{' })).toBeNull()
    expect(boardPreviewReference({ tool: 'toushou_board_add_widget', input: {}, output: { ok: false, board: { id: 'x' }, createdWidgetId: 'y' } })).toBeNull()
    expect(boardPreviewReference({ tool: 'toushou_board_add_widget', input: {}, output: { ok: true, board: { id: 'x' } } })).toBeNull()
  })
})
