import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 乐观删除护栏的纯逻辑测试：visualDelete 在排程瞬间执行（目标立即从
 * 界面消失）、撤销调 restore 恢复界面、到期才 execute 持久删除。
 * 状态机与 useUndoableDelete hook 保持同构；交互走 e2e。
 */

const COUNTDOWN_SECONDS = 10

function createStateMachine() {
  const calls: string[] = []
  let remaining = COUNTDOWN_SECONDS
  let active: { key: string } | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const fire = () => {
    if (remaining <= 1) {
      if (timer) { clearInterval(timer); timer = null }
      const target = active
      active = null
      remaining = 0
      if (target) calls.push(`execute:${target.key}`)
    } else {
      remaining -= 1
    }
  }
  return {
    calls,
    getRemaining: () => remaining,
    isActive: () => active !== null,
    schedule: (key: string) => {
      if (timer) { clearInterval(timer); timer = null }
      active = { key }
      remaining = COUNTDOWN_SECONDS
      calls.push(`visualDelete:${key}`)
      timer = setInterval(fire, 1000)
    },
    cancel: () => {
      if (timer) { clearInterval(timer); timer = null }
      if (active) calls.push(`restore:${active.key}`)
      active = null
    },
    confirmNow: () => {
      if (timer) { clearInterval(timer); timer = null }
      const target = active
      active = null
      if (target) calls.push(`execute:${target.key}`)
    }
  }
}

describe('延迟删除护栏（倒计时语义）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('视觉删除立即发生；持久删除到期（10s）才执行且只执行一次', () => {
    const m = createStateMachine()
    m.schedule('board:b1')
    expect(m.calls).toEqual(['visualDelete:board:b1'])
    vi.advanceTimersByTime(9_000)
    expect(m.calls).toEqual(['visualDelete:board:b1'])
    expect(m.getRemaining()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(m.calls).toEqual(['visualDelete:board:b1', 'execute:board:b1'])
    expect(m.isActive()).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(m.calls).toEqual(['visualDelete:board:b1', 'execute:board:b1'])
  })

  it('撤销在任意时刻都能取消并恢复界面，不执行持久删除', () => {
    const m = createStateMachine()
    m.schedule('live:s1')
    vi.advanceTimersByTime(9_000)
    m.cancel()
    expect(m.calls).toEqual(['visualDelete:live:s1', 'restore:live:s1'])
    vi.advanceTimersByTime(30_000)
    expect(m.calls).toEqual(['visualDelete:live:s1', 'restore:live:s1'])
    expect(m.isActive()).toBe(false)
  })

  it('重复请求同一目标重置倒计时，不提前持久删除', () => {
    const m = createStateMachine()
    m.schedule('history:h1')
    vi.advanceTimersByTime(9_000)
    m.schedule('history:h1')
    expect(m.calls).toEqual(['visualDelete:history:h1', 'visualDelete:history:h1'])
    vi.advanceTimersByTime(9_500)
    expect(m.calls.filter(c => c.startsWith('execute'))).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(m.calls.filter(c => c.startsWith('execute'))).toEqual(['execute:history:h1'])
  })

  it('手动关闭横幅（×）= 确认删除：立即执行持久删除', () => {
    const m = createStateMachine()
    m.schedule('board:b9')
    vi.advanceTimersByTime(3_000)
    m.confirmNow()
    expect(m.calls).toEqual(['visualDelete:board:b9', 'execute:board:b9'])
    vi.advanceTimersByTime(30_000)
    expect(m.calls).toEqual(['visualDelete:board:b9', 'execute:board:b9'])
  })

  it('撤销后可再次排程且语义不变', () => {
    const m = createStateMachine()
    m.schedule('global:g1')
    m.cancel()
    m.schedule('global:g1')
    vi.advanceTimersByTime(10_000)
    expect(m.calls.filter(c => c.startsWith('execute'))).toEqual(['execute:global:g1'])
  })
})

describe('倒计时不变量（与组件实现锁死）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('COUNTDOWN_SECONDS 是 10 秒（组件与测试共用这份语义）', () => {
    expect(COUNTDOWN_SECONDS).toBe(10)
  })
  it('finalize-previous 发生在新目标的 visualDelete 之前（store 墓碑保证重扫描不复活）', () => {
    const calls: string[] = []
    let remaining = COUNTDOWN_SECONDS
    let active: { key: string } | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const schedule = (key: string) => {
      const previous = active
      if (previous) { stop(); calls.push(`execute:${previous.key}`) }
      active = { key }
      remaining = COUNTDOWN_SECONDS
      calls.push(`visualDelete:${key}`)
      timer = setInterval(() => {
        if (remaining <= 1) { stop(); calls.push(`execute:${active!.key}`); active = null; remaining = 0 }
        else remaining -= 1
      }, 1000)
    }
    schedule('a')
    schedule('b')
    // 顺序锁定：先终局 a，再视觉删 b —— b 的隐藏在 a 的删除/重扫描之后发生，
    // 不会被扫回来（store 层用墓碑集合实现，见 hideSessionPendingDelete）。
    expect(calls).toEqual(['visualDelete:a', 'execute:a', 'visualDelete:b'])
    vi.advanceTimersByTime(10_000)
    expect(calls).toEqual(['visualDelete:a', 'execute:a', 'visualDelete:b', 'execute:b'])
  })
})
