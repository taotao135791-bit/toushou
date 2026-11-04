import { describe, expect, it } from 'vitest'
import { boardPreviewReference, groupBoardPreviews } from './BoardChatPreview'
import { normalizeToolCall } from '@shared/toolNames'

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
  it('recognizes the exact write proxy and structured runtime result', () => {
    const output = { content: [{ type: 'text', text: JSON.stringify(result) }] }
    const input = { path: 'xd://toushou_board_add_widget', content: JSON.stringify({ boardId: 'synthetic-board', type: 'file' }) }
    const expected = { boardId: 'synthetic-board', widgetId: 'synthetic-widget' }
    expect(boardPreviewReference({ tool: 'write', input, output })).toEqual(expected)
    expect(boardPreviewReference({ tool: 'write', input: JSON.stringify(input), output: JSON.stringify(output) })).toEqual(expected)
    expect(boardPreviewReference({ name: 'write', arguments: input, result: output } as never)).toEqual(expected)
    expect(boardPreviewReference({ tool: 'write', input: { ...input, path: 'xd://toushou_board_add_widget/extra' }, output })).toBeNull()
  })
  it('recognizes updates only when the successful saved board actually contains the requested supported component', () => {
    const saved = { ok: true, board: { id: 'board', updatedAt: 2, widgets: [{ id: 'html', type: 'file' }] } }
    const ref = { boardId: 'board', widgetId: 'html', revision: 2 }
    expect(boardPreviewReference({ tool: 'toushou_board_update_widget', input: { widgetId: 'html' }, output: saved })).toEqual(ref)
    expect(boardPreviewReference({ tool: 'write', input: { path: 'xd://toushou_board_update_widget', content: '{"widgetId":"html"}' }, output: saved })).toEqual(ref)
    const normalized = normalizeToolCall('write', { path: 'xd://toushou_board_update_widget', content: '{"widgetId":"html"}' })
    expect(boardPreviewReference({ ...normalized, output: saved })).toEqual(ref)
    expect(boardPreviewReference({ tool: 'toushou_board_update_widget', input: { widgetId: 'missing' }, output: saved })).toBeNull()
    expect(boardPreviewReference({ tool: 'toushou_board_update_widget', input: { widgetId: 'html' }, output: { ok: true, board: { id: 'board' } } })).toBeNull()
    expect(boardPreviewReference({ tool: 'toushou_board_update_widget', input: { widgetId: 'html' }, output: { ...saved, ok: false } })).toBeNull()
    expect(boardPreviewReference({ tool: 'toushou_board_add_widget', input: {}, output: { ...saved, createdWidgetId: 'note', board: { id: 'board', widgets: [{ id: 'note', type: 'note' }] } } })).toBeNull()
  })
  it('groups by board, retains every distinct component and refreshes a repeated component after an update', () => {
    expect(groupBoardPreviews([{ boardId: 'a', widgetId: 'one', revision: 1 }, { boardId: 'a', widgetId: 'two', revision: 2 }, { boardId: 'b', widgetId: 'other' }, { boardId: 'a', widgetId: 'one', revision: 3 }])).toEqual([
      { boardId: 'a', widgetIds: ['one', 'two'], revision: 3 }, { boardId: 'b', widgetIds: ['other'] }
    ])
  })
})
