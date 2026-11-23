/**
 * Frame-batched stream queue (学 deepseek-harness 的 rafBatch：一帧内 N 次
 * 更新合并成 1 次渲染). Model streams arrive far faster than the display
 * refresh; applying every delta as its own store notification re-rendered the
 * whole transcript per token. Segments now accumulate and flush once per
 * animation frame — state ordering is preserved exactly (segments apply in
 * arrival order; barriers run after everything enqueued before them).
 *
 * Latency guard: a minimized/hidden Electron window throttles rAF to ~0, so a
 * 100ms timer races the frame callback — the stream never stalls visually
 * behind an invisible window for longer than that.
 */

export interface StreamSegment {
  kind: 'thinking' | 'content'
  sessionId: string
  delta: string
}

export interface StreamBarrier {
  kind: 'barrier'
  sessionId: string
  fn: () => void
}

export type StreamQueueItem = StreamSegment | StreamBarrier

export interface StreamQueueOptions {
  /** Apply one session's batched segments in arrival order (single set). */
  apply: (sessionId: string, segments: Array<{ kind: 'thinking' | 'content'; delta: string }>) => void
  /** Run an ordering barrier AFTER everything enqueued before it. */
  barrier: (fn: () => void) => void
  /** Test seam: scheduling primitive. Defaults to rAF with timer guard. */
  scheduler?: (flush: () => void) => () => void
}

const FLUSH_GUARD_MS = 100

export interface StreamQueue {
  push(segment: Omit<StreamSegment, never>): void
  pushBarrier(sessionId: string, fn: () => void): void
  /** Flush pending work now (tests, and teardown before navigation). */
  flushNow(): void
  /** Pending item count (diagnostics/tests). */
  pending(): number
}

export function createStreamQueue(options: StreamQueueOptions): StreamQueue {
  const queue: StreamQueueItem[] = []
  let scheduled = false
  const defaultScheduler = (flush: () => void) => {
    const timers: number[] = []
    let fired = false
    const run = () => {
      if (fired) return
      fired = true
      timers.forEach(timer => clearTimeout(timer))
      flush()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else queueMicrotask(run)
    timers.push(setTimeout(run, FLUSH_GUARD_MS) as unknown as number)
    return () => {
      fired = true
      timers.forEach(timer => clearTimeout(timer))
    }
  }
  const schedule = options.scheduler ?? defaultScheduler
  const flush = () => {
    scheduled = false
    if (queue.length === 0) return
    const items = queue.splice(0, queue.length)
    // Group consecutive same-session segments; a barrier flushes its leading
    // group first so everything before it is applied when the barrier runs.
    for (let i = 0; i < items.length; ) {
      const item = items[i]!
      if (item.kind === 'barrier') {
        options.barrier(item.fn)
        i++
        continue
      }
      let j = i
      const segments: Array<{ kind: 'thinking' | 'content'; delta: string }> = []
      while (j < items.length) {
        const next = items[j]!
        if (next.kind !== 'barrier' && next.sessionId === item.sessionId) {
          segments.push({ kind: next.kind, delta: next.delta })
          j++
        } else break
      }
      options.apply(item.sessionId, segments)
      i = j
    }
  }
  const ensureScheduled = () => {
    if (scheduled) return
    scheduled = true
    void schedule(flush)
  }
  return {
    push: (segment) => {
      queue.push({ ...segment })
      ensureScheduled()
    },
    pushBarrier: (sessionId, fn) => {
      queue.push({ kind: 'barrier', sessionId, fn })
      ensureScheduled()
    },
    flushNow: flush,
    pending: () => queue.length
  }
}
