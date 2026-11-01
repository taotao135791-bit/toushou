import { describe, expect, it } from 'vitest'
import type { BoardWidget } from '@shared/types'
import { resizeWidgetLayout, resolveResizeStop, shouldRevealMovedWidget } from './widgetSizing'

const widget = (id: string, x: number, y: number, w: number, h: number): BoardWidget => ({ id, type: 'reading-module', title: 'Fixture', layout: { x, y, w, h }, config: { snapshot: { fixture: true }, module: { kind: 'coverage' } } })
describe('precise card dimensions', () => {
  it('keeps position when free, and moves to an empty slot when resizing would overlap', () => {
    const a = widget('a', 0, 0, 3, 4), b = widget('b', 3, 0, 3, 4)
    expect(resizeWidgetLayout(a, [a, b], 3, 5)).toEqual({ x: 0, y: 0, w: 3, h: 5 })
    const next = resizeWidgetLayout(a, [a, b], 6, 5)!
    expect(next).toEqual({ x: 6, y: 0, w: 6, h: 5 })
    expect(a.layout).toEqual({ x: 0, y: 0, w: 3, h: 4 })
    expect(a.config).toEqual({ snapshot: { fixture: true }, module: { kind: 'coverage' } })
  })
  it('recovers the latest drag dimensions if grid stop returns an older layout', () => {
    const a = widget('a', 0, 0, 3, 4), b = widget('b', 3, 0, 3, 4)
    const stop = [{ i: 'a', ...a.layout }, { i: 'b', ...b.layout }]
    const resolved = resolveResizeStop([a, b], stop, { id: 'a', width: 6, height: 5 })
    expect(resolved.find(item => item.i === 'a')).toEqual({ i: 'a', x: 6, y: 0, w: 6, h: 5 })
    expect(resolved.find(item => item.i === 'b')).toEqual(stop[1])
    expect(resolveResizeStop([a, b], stop, null)).toBe(stop)
    expect(resolveResizeStop([a, b], stop, { id: 'a', width: 3, height: 4 })).toBe(stop)
    expect(resolveResizeStop([a, b], stop, { id: 'a', width: 13, height: 4 })).toBe(stop)
  })
  it('only reveals a moved widget while the user is still on its board', () => {
    expect(shouldRevealMovedWidget({ boardId: 'a', surface: 'board' }, 'a', true)).toBe(true)
    expect(shouldRevealMovedWidget({ boardId: 'b', surface: 'board' }, 'a', true)).toBe(false)
    expect(shouldRevealMovedWidget({ boardId: 'a', surface: 'today' }, 'a', true)).toBe(false)
    expect(shouldRevealMovedWidget({ boardId: 'a', surface: 'board' }, 'a', false)).toBe(false)
  })
  it('respects grid bounds and rejects invalid or fractional dimensions', () => {
    const a = widget('a', 9, 0, 3, 4)
    expect(resizeWidgetLayout(a, [a], 6, 4)).toEqual({ x: 6, y: 0, w: 6, h: 4 })
    for (const [w, h] of [[1, 2], [13, 2], [2, 1], [2, 21], [2.5, 2], [NaN, 3]]) expect(resizeWidgetLayout(a, [a], w, h)).toBeNull()
  })
})
