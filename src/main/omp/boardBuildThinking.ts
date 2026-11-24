import { SESSION_THINKING_LEVELS, type SessionState, type SessionThinkingLevel } from '../../shared/types'

interface PendingThinkingChange {
  buildId: string
  previous?: SessionThinkingLevel
}

interface BoardBuildThinkingRuntime {
  read(sessionId: string): Promise<Pick<SessionState, 'thinkingLevel' | 'modelThinking'> | null>
  write(sessionId: string, level: SessionThinkingLevel): Promise<boolean>
  isActive(sessionId: string, buildId: string): boolean
}

/** Temporarily lower effort for an active draft. Writing is synchronous at
 * the transport boundary even though its acknowledgment arrives later. */
export class BoardBuildThinking {
  private readonly pending = new Map<string, PendingThinkingChange>()

  constructor(private readonly runtime: BoardBuildThinkingRuntime) {}

  async start(sessionId: string, buildId: string): Promise<void> {
    if (this.pending.get(sessionId)?.buildId === buildId || !this.runtime.isActive(sessionId, buildId)) return
    this.finish(sessionId)
    const request: PendingThinkingChange = { buildId }
    this.pending.set(sessionId, request)
    try {
      const state = await this.runtime.read(sessionId)
      if (this.pending.get(sessionId) !== request || !this.runtime.isActive(sessionId, buildId)) return
      const previous = SESSION_THINKING_LEVELS.find(level => level === state?.thinkingLevel)
      if (!previous || SESSION_THINKING_LEVELS.indexOf(previous) <= SESSION_THINKING_LEVELS.indexOf('medium')) return
      const capability = state?.modelThinking
      if (capability?.reasoning === false || (capability?.thinking.length && !capability.thinking.includes('medium'))) return
      // Register first so a finish while the RPC is pending still queues the
      // original effort after this write and before subsequent user input.
      request.previous = previous
      await this.runtime.write(sessionId, 'medium')
    } catch {
      // A failed optimization must not interrupt building or publishing.
    } finally {
      if (this.pending.get(sessionId) === request && request.previous === undefined) this.pending.delete(sessionId)
    }
  }

  finish(sessionId: string, buildId?: string): void {
    const request = this.pending.get(sessionId)
    if (!request || (buildId !== undefined && request.buildId !== buildId)) return
    this.pending.delete(sessionId)
    if (request.previous !== undefined) void this.runtime.write(sessionId, request.previous).catch(() => undefined)
  }

  /** A repeated begin for the same draft cannot override an explicit action. */
  stopForDraft(sessionId: string, buildId?: string): void {
    this.finish(sessionId)
    if (buildId && this.runtime.isActive(sessionId, buildId)) this.pending.set(sessionId, { buildId })
  }

  close(sessionId: string): void {
    this.pending.delete(sessionId)
  }
}
