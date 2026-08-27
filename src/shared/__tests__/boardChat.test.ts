import { describe, expect, it } from 'vitest'
import { buildBoardChatPrompt } from '../boardChat'
import { BoardDataset, KanbanBoard } from '../types'

const board: KanbanBoard = {
  id: 'board-1',
  name: 'Growth review',
  description: 'Weekly decision dashboard',
  createdAt: 1,
  updatedAt: 1,
  widgets: [
    {
      id: 'note-1',
      type: 'note',
      title: 'Private note',
      layout: { x: 0, y: 0, w: 3, h: 3 },
      config: { text: 'This must not leave in the board snapshot.' }
    },
    {
      id: 'counter-1',
      type: 'counter',
      title: 'Spend',
      layout: { x: 3, y: 0, w: 3, h: 3 },
      config: { source: 'dataset', datasetId: 'dataset-1', metric: 'Spend', op: 'sum' }
    }
  ]
}

const datasets: BoardDataset[] = [
  {
    id: 'dataset-1',
    name: 'Daily export',
    columns: [
      { name: 'Date', type: 'date' },
      { name: 'Spend', type: 'number' }
    ],
    rows: [['2026-08-01', 42]],
    createdAt: 1
  }
]

describe('buildBoardChatPrompt', () => {
  it('gives the agent a bounded board/schema summary without note contents or dataset rows', () => {
    const prompt = buildBoardChatPrompt(board, datasets)
    expect(prompt).toContain('Growth review')
    expect(prompt).toContain('Spend')
    expect(prompt).toContain('1 rows')
    expect(prompt).toContain('note text withheld')
    expect(prompt).not.toContain('This must not leave')
    expect(prompt).not.toContain('2026-08-01')
  })

  it('uses a Chinese reviewable draft when the app language is Chinese', () => {
    expect(buildBoardChatPrompt(board, datasets, 'zh')).toContain('本地看板快照')
  })
})
