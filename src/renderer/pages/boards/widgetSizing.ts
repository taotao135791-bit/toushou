import { GRID_COLS, GRID_MAX_H, findFreeSlot } from '@shared/boards'
import type { BoardWidget, BoardWidgetLayout } from '@shared/types'

/** Validate dimensions and place the resized card without covering another card. */
export function resizeWidgetLayout(widget: BoardWidget, widgets: BoardWidget[], width: number, height: number): BoardWidgetLayout | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || width > GRID_COLS || height < 2 || height > GRID_MAX_H) return null
  const others = widgets.filter(item => item.id !== widget.id)
  const candidate = { x: Math.min(widget.layout.x, GRID_COLS - width), y: widget.layout.y, w: width, h: height }
  const overlaps = others.some(({ layout }) => candidate.x < layout.x + layout.w && layout.x < candidate.x + candidate.w && candidate.y < layout.y + layout.h && layout.y < candidate.y + candidate.h)
  if (!overlaps) return candidate
  return { ...findFreeSlot(others, width, height), w: width, h: height }
}

/** Recover the latest resize callback if RGL stop observes its previous state. */
export function resolveResizeStop<T extends { i: string; x: number; y: number; w: number; h: number }>(
  widgets: BoardWidget[], layout: T[], last: { id: string; width: number; height: number } | null
): T[] {
  if (!last) return layout
  const entry = layout.find(item => item.i === last.id)
  if (!entry || (entry.w === last.width && entry.h === last.height)) return layout
  const projected = widgets.map(widget => {
    const current = layout.find(item => item.i === widget.id)
    return current ? { ...widget, layout: { x: current.x, y: current.y, w: current.w, h: current.h } } : widget
  })
  const target = projected.find(widget => widget.id === last.id)
  const corrected = target && resizeWidgetLayout(target, projected, last.width, last.height)
  return corrected ? layout.map(item => item.i === last.id ? { ...item, ...corrected } : item) : layout
}

/** Async saves must not pull the user back to a board they have left. */
export function shouldRevealMovedWidget(view: { boardId: string | null; surface: 'today' | 'board' }, boardId: string, moved: boolean): boolean {
  return moved && view.surface === 'board' && view.boardId === boardId
}
