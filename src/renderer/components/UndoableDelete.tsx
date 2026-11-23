import { useCallback, useEffect, useRef, useState } from 'react'
import { Undo2, X } from 'lucide-react'
import { useT } from '../i18n'

/**
 * 延迟删除护栏：用户点删除后不立即执行，而是进入 10 秒倒计时——页面顶部
 * 显示带进度条与剩余秒数的横幅，用户可随时撤销。倒计时结束才真正执行删除。
 * 避免误删重要看板/对话（学 dsh 的 latest-wins + 可撤销交互）。
 *
 * 约定：执行函数返回 Promise；横幅全屏固定，点撤销或 × 立即取消。
 */

export interface PendingDeletion {
  /** 稳定键：同一目标重复请求删除时重置倒计时，不叠加。 */
  key: string
  /** 展示名（看板名/会话标题）。 */
  title: string
  /**
   * 立即执行的"视觉删除"：让目标从界面上消失（乐观删除）。真正的持久
   * 删除在倒计时结束时才发生；撤销则把界面恢复。
   */
  visualDelete: () => void
  /** 撤销时恢复界面（目标回到列表/看板）。 */
  restore: () => void
  /** 到期真正执行的持久删除；异常静默（调用方自行 flash 反馈）。 */
  execute: () => Promise<void>
}

const COUNTDOWN_SECONDS = 10

export function useUndoableDelete() {
  const [pending, setPending] = useState<PendingDeletion | null>(null)
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pendingRef = useRef<PendingDeletion | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** 撤销：恢复界面，不删除。 */
  const cancel = useCallback(() => {
    clearTimer()
    const target = pendingRef.current
    pendingRef.current = null
    setPending(null)
    if (target) target.restore()
  }, [clearTimer])

  /** 手动关闭横幅：视为确认删除——立即执行持久删除，不再等倒计时。 */
  const confirm = useCallback(() => {
    clearTimer()
    const target = pendingRef.current
    pendingRef.current = null
    setPending(null)
    if (target) void target.execute().catch(() => {})
  }, [clearTimer])

  const schedule = useCallback((request: PendingDeletion) => {
    // 连续删除第二个目标时，前一个不能被静默丢弃（否则它停留在"视觉已删
    // 但从未持久删除"的幽灵态，重扫描会复活）——立即执行它的持久删除。
    const previous = pendingRef.current
    if (previous) {
      clearTimer()
      pendingRef.current = null
      void previous.execute().catch(() => {})
    }
    pendingRef.current = request
    setPending(request)
    setRemaining(COUNTDOWN_SECONDS)
    // 乐观删除：点删除的瞬间就从界面消失；撤销才回来。
    request.visualDelete()
    timerRef.current = setInterval(() => {
      setRemaining((seconds) => {
        if (seconds <= 1) {
          clearTimer()
          const target = pendingRef.current
          pendingRef.current = null
          setPending(null)
          if (target) void target.execute().catch(() => {})
          return 0
        }
        return seconds - 1
      })
    }, 1000)
  }, [clearTimer])

  useEffect(() => () => clearTimer(), [clearTimer])

  return { pending, remaining, schedule, cancel, confirm }
}

/**
 * 倒计时横幅：固定在页面**底部**（顶部会挡住看板标签栏和总控条），进度条
 * 随秒数收缩。「撤销」恢复界面；× 关闭 = 确认删除（立即执行，不等倒计时）。
 */
export function UndoableDeleteBanner({
  pending,
  remaining,
  onUndo,
  onConfirm,
  seconds = COUNTDOWN_SECONDS
}: {
  pending: PendingDeletion | null
  remaining: number
  onUndo: () => void
  onConfirm: () => void
  seconds?: number
}) {
  const t = useT()
  if (!pending) return null
  const pct = Math.max(0, Math.min(100, (remaining / seconds) * 100))
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex justify-center px-4 pb-4" role="alert" aria-live="assertive">
      <div className="pointer-events-auto relative w-full max-w-md overflow-hidden rounded-xl border border-line bg-ink-900 shadow-pop">
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-cream">
            <span className="font-medium">{pending.title}</span>
            <span className="text-cream-faint"> {t('undoDelete.deleted')} · </span>
            <span className="tabular-nums text-cream-faint">{remaining}s {t('undoDelete.after')}</span>
          </span>
          <button
            type="button"
            onClick={onUndo}
            className="flex shrink-0 items-center gap-1 rounded-full bg-cream px-2.5 py-1 text-[11.5px] font-medium text-ink-950 transition hover:opacity-90"
          >
            <Undo2 size={11} />
            {t('undoDelete.undo')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            aria-label={t('undoDelete.confirmNow')}
            className="shrink-0 rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
          >
            <X size={12} />
          </button>
        </div>
        <div className="h-[3px] w-full bg-overlay">
          <div
            className="h-full bg-amber-500 transition-[width] duration-1000 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  )
}
