import { describe, expect, it } from 'vitest'
import { createStreamQueue } from './streamQueue'

/** Deterministic manual scheduler: nothing flushes until flushNow(). */
const manual = (): { schedule: (flush: () => void) => () => void } => ({
  schedule: () => () => {}
})

describe('createStreamQueue', () => {
  it('folds one frame of same-session segments into ONE apply call, in order', () => {
    const applies: Array<{ sessionId: string; segments: Array<{ kind: string; delta: string }> }> = []
    const queue = createStreamQueue({
      apply: (sessionId, segments) => applies.push({ sessionId, segments: [...segments] }),
      barrier: (fn) => fn(),
      scheduler: manual().schedule
    })
    queue.push({ kind: 'thinking', sessionId: 's1', delta: 'a' })
    queue.push({ kind: 'thinking', sessionId: 's1', delta: 'b' })
    queue.push({ kind: 'content', sessionId: 's1', delta: 'c' })
    queue.push({ kind: 'content', sessionId: 's1', delta: 'd' })
    expect(applies).toEqual([])
    queue.flushNow()
    expect(applies).toEqual([{
      sessionId: 's1',
      segments: [
        { kind: 'thinking', delta: 'a' },
        { kind: 'thinking', delta: 'b' },
        { kind: 'content', delta: 'c' },
        { kind: 'content', delta: 'd' }
      ]
    }])
    expect(queue.pending()).toBe(0)
  })

  it('runs barriers strictly after the segments enqueued before them', () => {
    const order: string[] = []
    const queue = createStreamQueue({
      apply: (_sessionId, segments) => order.push(`apply:${segments.length}`),
      barrier: (fn) => { order.push('barrier:start'); fn(); order.push('barrier:end') },
      scheduler: manual().schedule
    })
    queue.push({ kind: 'content', sessionId: 's', delta: 'x' })
    queue.pushBarrier('s', () => order.push('fn'))
    queue.push({ kind: 'content', sessionId: 's', delta: 'y' })
    queue.flushNow()
    expect(order).toEqual(['apply:1', 'barrier:start', 'fn', 'barrier:end', 'apply:1'])
  })

  it('keeps concurrent sessions in separate apply groups', () => {
    const groups: string[] = []
    const queue = createStreamQueue({
      apply: (sessionId) => groups.push(sessionId),
      barrier: (fn) => fn(),
      scheduler: manual().schedule
    })
    queue.push({ kind: 'content', sessionId: 'a', delta: '1' })
    queue.push({ kind: 'content', sessionId: 'b', delta: '1' })
    queue.push({ kind: 'content', sessionId: 'a', delta: '2' })
    queue.flushNow()
    expect(groups).toEqual(['a', 'b', 'a'])
  })

  it('auto-schedules a flush through the provided scheduler', () => {
    let flushed = false
    const queue = createStreamQueue({
      apply: () => { flushed = true },
      barrier: (fn) => fn(),
      scheduler: (flush) => { flush(); return () => {} }
    })
    queue.push({ kind: 'content', sessionId: 's', delta: 'x' })
    expect(flushed).toBe(true)
  })
})
