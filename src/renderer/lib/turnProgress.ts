import { parseTodoInput } from './todoInput'

export interface PlanProgress { done: number; total: number; current?: string; blocked?: number }

export function isPlanTool(tool: string) {
  return ['todo', 'todo_write', 'todowrite', 'plan', 'update_plan'].includes(tool.toLowerCase())
}

export function readPlanProgress(tool: string, input: unknown): PlanProgress | undefined {
  if (!isPlanTool(tool)) return
  const items = parseTodoInput(input)
  if (!items?.length) return
  return {
    done: items.filter(item => item.state === 'done').length,
    total: items.length,
    current: items.find(item => item.state === 'in_progress')?.label
  }
}

// OMP's native todo supports operations such as init, done, append and rm.
// Its successful result includes a fresh summary across *all* phases, even
// when the input contains only the name of one task.
export function readPlanResult(output: unknown): PlanProgress | null | undefined {
  if (typeof output !== 'string') return
  if (output === 'Todo list cleared.' || output === 'Todo list is empty.') return null
  const summary = /^Overall: (\d+)\/(\d+) done, (\d+) open(?:, (\d+) blocked)?\.$/m.exec(output)
  if (!summary) return
  const done = Number(summary[1]), total = Number(summary[2])
  const open = Number(summary[3]), blocked = Number(summary[4] ?? 0)
  if (!Number.isSafeInteger(total) || !total || done + open + blocked !== total) return
  const current = /^  - (.+) \[in_progress\] \(.+\)$/m.exec(output)?.[1].slice(0, 300)
  return { done, total, current, blocked }
}

export interface PlanTiming { from: number; done: number; etaAt?: number }

// Measure observed completions. A repeated update keeps the same deadline;
// changing the plan size or moving a task back to pending resets the sample.
export function timePlan(previous: PlanProgress | undefined, timing: PlanTiming | undefined, next: PlanProgress, now: number): PlanTiming {
  if (!previous || !timing || previous.total !== next.total || previous.done > next.done || previous.blocked !== next.blocked) return { from: now, done: next.done }
  if (next.done === previous.done) return timing
  const advanced = next.done - timing.done
  const duration = now - timing.from
  const etaAt = duration >= 15000 && advanced > 0 && next.done < next.total
    ? now + duration * (next.total - next.done) / advanced : undefined
  return { ...timing, etaAt }
}

const milestones: Record<string, number> = {
  board_build_begin: 5, board_create: 45, board_add_widget: 65, board_customize: 65,
  board_refresh: 80, board_check: 90, board_build_preflight: 90, board_build_commit: 97
}

// Board tools report milestones rather than a fixed sequence of steps.
export function boardMilestone(tool: string, previous?: number): number | undefined {
  const name = tool.replace(/^toushou_/, '')
  if (name === 'board_build_abort') return undefined
  if (previous === undefined && name !== 'board_build_begin' && name !== 'board_create') return
  const percent = milestones[name] ?? (previous && ['tiktok_update', 'af_dataset_pull', 'appsflyer_apps', 'board_meta_accounts'].includes(name) ? 30 : 0)
  return percent > 0 ? Math.max(previous ?? 0, percent) : previous
}

/** Estimate a running turn from measured progress, a live plan ETA, or recent turn durations. */
export function estimatedTurnProgress(
  elapsedSeconds: number,
  measuredPercent?: number,
  planEtaSeconds?: number,
  expectedDurationSeconds?: number
): { percent: number; remainingSeconds?: number } {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0
  const planned = planEtaSeconds !== undefined && Number.isFinite(planEtaSeconds) && planEtaSeconds > 0 ? planEtaSeconds : undefined
  const expected = expectedDurationSeconds !== undefined && Number.isFinite(expectedDurationSeconds) && expectedDurationSeconds > 0
    ? Math.max(15, expectedDurationSeconds) : 45
  const duration = planned === undefined ? expected : elapsed + planned
  const estimatedPercent = 90 * Math.min(1, elapsed / duration)
  const measured = measuredPercent !== undefined && Number.isFinite(measuredPercent)
    ? Math.min(98, Math.max(0, measuredPercent)) : 0
  const remaining = planned ?? (expected - elapsed)
  return {
    percent: Math.round(Math.max(measured, estimatedPercent)),
    remainingSeconds: remaining > 0 ? Math.ceil(remaining) : undefined
  }
}

export function formatProgressTime(seconds: number, language: 'en' | 'zh') {
  const value = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(value / 60)
  const rest = value % 60
  if (language === 'zh') return minutes ? `${minutes} 分 ${rest} 秒` : `${value} 秒`
  return minutes ? `${minutes}:${String(rest).padStart(2, '0')}` : `${value}s`
}
