import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { currentTurn, type ExecutionProjection } from '../lib/execution'
import { presentToolCall } from '../lib/toolPresentation'
import { estimatedTurnProgress, formatProgressTime } from '../lib/turnProgress'
import { useActivityClock } from '../lib/useActivityClock'

interface Props { sessionId: string; waiting: boolean; stopping: boolean; compacting: boolean }

interface TurnView {
  turnId?: string
  percent: number
  pausedAt?: number
  pausedMs: number
}

const initialView: TurnView = { percent: 0, pausedMs: 0 }

function recentTurnDuration(execution: ExecutionProjection | undefined): number | undefined {
  if (!execution) return
  const samples = execution.turnOrder.slice(-6).flatMap(id => {
    const turn = execution.turns[id]
    if (turn?.status !== 'completed' || turn.startedAt === undefined || turn.endedAt === undefined) return []
    const seconds = (turn.endedAt - turn.startedAt) / 1000
    return seconds > 0 ? [seconds] : []
  }).sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]
}

/** Only the visible, active session subscribes. Text deltas leave these
 * selector values stable and the second tick never touches the transcript. */
export default memo(function RunningTurnProgress({ sessionId, waiting, stopping, compacting }: Props) {
  const { language, turnId, startedAt, plan, boardProgress, etaAt, lastTool, lastEvent, tools, status } = useAppStore(useShallow(s => {
    const execution = s.executions[sessionId]
    const turn = execution && currentTurn(execution)
    return {
      language: s.language, turnId: turn?.id, startedAt: turn?.startedAt, plan: turn?.planProgress,
      boardProgress: turn?.boardProgress, etaAt: turn?.planTiming?.etaAt,
      lastTool: turn?.lastAction?.tool, lastEvent: turn?.trajectory.at(-1)?.kind,
      tools: turn?.tools, status: execution?.sessionStatus
    }
  }))
  const zh = language === 'zh'
  const paused = waiting || status === 'waiting_for_user'
  const ending = stopping || status === 'aborting'
  const suspended = paused || ending || compacting
  const now = useActivityClock(startedAt !== undefined && !suspended)
  const toolLabel = useMemo(() => lastTool && presentToolCall({ tool: lastTool, input: {} }, language).label, [lastTool, language])
  // Completed duration samples stay stable for the lifetime of the active turn.
  const recentDuration = useMemo(() => recentTurnDuration(useAppStore.getState().executions[sessionId]), [sessionId, turnId])
  const previous = useRef<TurnView>(initialView)
  const view = previous.current.turnId === turnId ? previous.current : initialView
  const resumedPause = !suspended && view.pausedAt !== undefined ? Math.max(0, now - view.pausedAt) : 0
  const pausedMs = view.pausedMs + resumedPause
  const elapsed = startedAt !== undefined && now > 0 ? Math.max(0, (now - startedAt - pausedMs) / 1000) : 0
  const measuredPercent = plan ? 100 * plan.done / plan.total : boardProgress
  const steps = tools ? Object.values(tools).reduce((total, count) => total + count, 0) : 0
  const planEta = !plan?.blocked && etaAt !== undefined && now > 0 ? (etaAt - now) / 1000 : undefined
  const planExpired = planEta !== undefined && planEta <= 0
  const estimate = estimatedTurnProgress(elapsed, measuredPercent, planEta, recentDuration)
  const percent = Math.max(view.percent, suspended ? 0 : estimate.percent)
  useLayoutEffect(() => {
    previous.current = {
      turnId, percent, pausedMs,
      pausedAt: suspended ? view.pausedAt ?? Date.now() : now > 0 ? undefined : view.pausedAt
    }
  }, [turnId, percent, pausedMs, suspended, view.pausedAt, now])

  const etaText = planExpired || estimate.remainingSeconds === undefined
    ? (zh ? '正在重新估算剩余时间' : 'Updating time estimate')
    : (zh ? '预计剩余约 ' : 'Estimated time left: ') + formatProgressTime(estimate.remainingSeconds, language)
  let label = zh ? '处理中' : 'Working'
  if (ending) label = zh ? '正在停止' : 'Stopping'
  else if (paused) label = zh ? '等待你的确认' : 'Awaiting your input'
  else if (compacting) label = zh ? '正在整理上下文' : 'Compacting context'
  else if (lastEvent === 'message') label = zh ? '正在回复' : 'Writing reply'
  else if (lastEvent === 'reasoning') label = zh ? '正在思考' : 'Thinking'
  else if (plan?.current) label = plan.current
  else if (toolLabel) label = toolLabel
  return <div className="mx-auto w-full max-w-[760px] px-4 pb-1.5" data-running-progress>
    <div className="mb-1 flex min-w-0 items-center gap-2 whitespace-nowrap text-[11px] leading-4 text-cream-faint">
      <span className="min-w-0 flex-1 truncate text-cream-dim" title={label}>{label}</span>
      {plan ? <span>{zh ? '计划 ' : 'Plan '}{plan.done}/{plan.total}</span> : steps > 0 && <span>{steps}{zh ? ' 个步骤' : ' steps'}</span>}
      {!suspended && <span className="shrink-0 tabular-nums" data-progress-eta>{etaText}</span>}
    </div>
    <div role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
      aria-valuetext={suspended ? label : etaText} className="h-1 w-full overflow-hidden rounded-full bg-overlay">
      <div className="h-full rounded-full bg-cream-faint/65 motion-safe:transition-[width] motion-safe:duration-500"
        style={{ width: `${percent}%` }} />
    </div>
  </div>
})
