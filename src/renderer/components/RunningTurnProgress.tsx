import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { currentTurn } from '../lib/execution'
import { presentToolCall } from '../lib/toolPresentation'
import { formatProgressTime } from '../lib/turnProgress'
import { useActivityClock } from '../lib/useActivityClock'

interface Props { sessionId: string; waiting: boolean; stopping: boolean; compacting: boolean }

/** Only the visible, active session subscribes. Text deltas leave these
 * selector values stable and the second tick never touches the transcript. */
export default memo(function RunningTurnProgress({ sessionId, waiting, stopping, compacting }: Props) {
  const { language, startedAt, plan, boardProgress, etaAt, lastTool, lastEvent, tools, status } = useAppStore(useShallow(s => {
    const execution = s.executions[sessionId]
    const turn = execution && currentTurn(execution)
    return {
      language: s.language, startedAt: turn?.startedAt, plan: turn?.planProgress,
      boardProgress: turn?.boardProgress, etaAt: turn?.planTiming?.etaAt,
      lastTool: turn?.lastAction?.tool, lastEvent: turn?.trajectory.at(-1)?.kind,
      tools: turn?.tools, status: execution?.sessionStatus
    }
  }))
  const zh = language === 'zh'
  const now = useActivityClock(startedAt !== undefined)
  const toolLabel = useMemo(() => lastTool && presentToolCall({ tool: lastTool, input: {} }, language).label, [lastTool, language])
  const percent = plan ? Math.round(100 * plan.done / plan.total) : boardProgress
  const elapsed = startedAt !== undefined && now > 0 ? Math.max(0, (now - startedAt) / 1000) : undefined
  const steps = tools ? Object.values(tools).reduce((total, count) => total + count, 0) : 0
  const paused = waiting || status === 'waiting_for_user'
  const ending = stopping || status === 'aborting'
  const eta = !ending && !paused && !compacting && !plan?.blocked && etaAt && now > 0 && etaAt > now
    ? Math.ceil((etaAt - now) / 1000) : undefined
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
      {percent !== undefined && <span>{!plan && (zh ? '看板约 ' : 'Board ~')}{percent}%</span>}
      {elapsed !== undefined && <span className="tabular-nums">{zh ? '已用 ' : 'Elapsed '}{formatProgressTime(elapsed)}</span>}
      {eta !== undefined && <span className="tabular-nums">{zh ? '计划预计剩余约 ' : 'Plan ETA ~'}{formatProgressTime(eta)}</span>}
    </div>
    <div role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
      className="h-1 w-full overflow-hidden rounded-full bg-overlay">
      <div className={`h-full rounded-full bg-cream-faint/65 ${percent !== undefined ? 'motion-safe:transition-[width]' : paused || ending ? '' : 'running-progress-indeterminate'}`}
        style={{ width: percent === undefined ? '30%' : `${percent}%` }} />
    </div>
  </div>
})
