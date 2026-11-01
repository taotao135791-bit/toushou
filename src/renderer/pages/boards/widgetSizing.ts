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
