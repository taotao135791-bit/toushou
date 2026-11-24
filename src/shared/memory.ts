/** 长期记忆的共享类型：Main 存储、renderer 管理界面、omp 工具三方共用。 */

export type MemoryScope = 'global' | 'project'

export interface MemoryEntrySource {
  /** 哪个对话让模型记下的（管理界面里可追溯）。 */
  sessionTitle?: string
  uuid?: string
}

export interface MemoryEntry {
  id: string
  text: string
  createdAt: number
  updatedAt: number
  source?: MemoryEntrySource
}

export interface MemoryLayerView {
  scope: MemoryScope
  entries: MemoryEntry[]
}

export type MemorySaveResult =
  | { ok: true; entry: MemoryEntry; duplicate: boolean }
  | { ok: false; error: 'invalid-text' | 'too-many-entries' | 'too-large' }
