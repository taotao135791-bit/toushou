import type { TikTokTodayProgressItem } from '../../../shared/todayReading'

export interface TikTokReadingProgress {
  requestId: string
  completed: number
  total: number
  succeeded: number
  today?: TikTokTodayProgressItem
}
interface ReadingDeps {
  signal?: AbortSignal
  onProgress?: (value: Omit<TikTokReadingProgress, 'requestId'>) => void
  onCommitting?: () => void
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id)

/** Scope cancellation and progress to the renderer that owns each request. */
export class TikTokReadingRequests {
  private readonly active = new Map<string, { controller: AbortController; committing: boolean }>()
  async run<T>(owner: number, id: unknown, work: (deps: ReadingDeps) => Promise<T>, emit: (value: TikTokReadingProgress) => void): Promise<T | { ok: false; error: 'invalid-input' }> {
    if (id === undefined) return work({})
    if (!validId(id)) return { ok: false, error: 'invalid-input' }
    const prefix = `${owner}:`, key = `${prefix}${id}`
    if (this.active.has(key) || [...this.active.keys()].filter(item => item.startsWith(prefix)).length >= 4) return { ok: false, error: 'invalid-input' }
    const controller = new AbortController()
    const state = { controller, committing: false }
    this.active.set(key, state)
    try {
      return await work({ signal: controller.signal, onCommitting: () => { state.committing = true }, onProgress: (value) => {
        if (controller.signal.aborted) return
        try { emit({ requestId: id, completed: value.completed, total: value.total, succeeded: value.succeeded, ...(value.today ? { today: value.today } : {}) }) } catch { /* closed renderer */ }
      } })
    } finally { this.active.delete(key) }
  }
  cancel(owner: number, id: unknown): boolean {
    if (!validId(id)) return false
    const state = this.active.get(`${owner}:${id}`)
    if (!state || state.committing) return false
    state.controller.abort()
    return true
  }
  cancelOwner(owner: number): void {
    const prefix = `${owner}:`
    for (const [key, state] of this.active) if (key.startsWith(prefix)) state.controller.abort()
  }
}
