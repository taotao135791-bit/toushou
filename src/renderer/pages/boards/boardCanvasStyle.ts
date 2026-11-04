import type { CSSProperties } from 'react'
import type { BoardStyle } from '@shared/types'

/** Apply saved canvas preferences only to the board, not the reading page. */
export function boardCanvasStyle(surface: 'board' | 'today', design?: BoardStyle, style?: BoardStyle): CSSProperties {
  if (surface !== 'board') return {}
  const effective = { ...design, ...style }
  const base: CSSProperties = effective.background ? { backgroundColor: effective.background } : {}
  if (effective.grid === 'dots') return {
    ...base,
    backgroundImage: 'radial-gradient(var(--line-strong) 1px, transparent 1px)',
    backgroundSize: '16px 16px'
  }
  if (effective.grid === 'lines') return {
    ...base,
    backgroundImage: 'linear-gradient(var(--line-strong) 1px, transparent 1px), linear-gradient(90deg, var(--line-strong) 1px, transparent 1px)',
    backgroundSize: '24px 24px'
  }
  return base
}
