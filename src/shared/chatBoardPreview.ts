import type { KanbanBoard } from './types'

export interface ChatBoardPreviewInput { sessionId: string; boardId: string; widgetId?: string }
export type ChatBoardPreviewResult =
  | { ok: true; source: 'board'; board: KanbanBoard }
  | { ok: true; html: string; source: 'snapshot' | 'module' | 'file'; boardName: string; widgetTitle: string }
  | { ok: false; error: 'invalid-input' | 'unauthorized' | 'not-found' | 'unsupported' | 'unavailable' }
