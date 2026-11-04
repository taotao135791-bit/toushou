import { describe, expect, it } from 'vitest'
import { boardCanvasStyle } from './boardCanvasStyle'

describe('board canvas appearance', () => {
  it('keeps default and today surfaces plain, even with a saved global board design', () => {
    expect(boardCanvasStyle('board')).toEqual({})
    expect(boardCanvasStyle('today', { background: '#112233', grid: 'dots' }, { background: '#445566', grid: 'lines' })).toEqual({})
  })
  it('preserves a saved global pattern and lets explicit per-board choices win', () => {
    expect(boardCanvasStyle('board', { background: '#112233', grid: 'dots' })).toMatchObject({ backgroundColor: '#112233', backgroundSize: '16px 16px' })
    expect(boardCanvasStyle('board', { background: '#112233', grid: 'dots' }, { background: '#445566', grid: 'lines' })).toMatchObject({ backgroundColor: '#445566', backgroundSize: '24px 24px' })
    expect(boardCanvasStyle('board', { background: '#112233', grid: 'dots' }, { grid: 'none' })).toEqual({ backgroundColor: '#112233' })
  })
})
