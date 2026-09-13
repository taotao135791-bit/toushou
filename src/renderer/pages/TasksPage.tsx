import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Play, Trash2, Clock, Calendar, Folder, Loader2, Pencil, MessageSquare, ChevronDown, ChevronRight } from 'lucide-react'
import { ScheduledTask } from '@shared/types'
import { useAppStore } from '../store'
import { useT, I18nKey } from '../i18n'
import { showNotice } from '../lib/notice'
import { useConfirmId } from '../lib/confirmClick'
import { basename } from '../lib/path'
import { formatRelativeTime } from '../lib/time'

function scheduleText(task: ScheduledTask, t: (key: never, vars?: Record<string, string | number>) => string): string {
  if (task.schedule.type === 'daily') return t('schedule.daily' as never, { time: task.schedule.time })
  if (task.schedule.type === 'weekdays') return t('schedule.weekdays' as never, { time: task.schedule.time })
  if (task.schedule.type === 'interval') {
    if (typeof task.schedule.minutes === 'number') {
      return t('schedule.intervalMinutes' as never, { minutes: task.schedule.minutes })
    }
    return t('schedule.interval' as never, { hours: task.schedule.hours ?? 0 })
  }
  if (task.schedule.type === 'weekly') return t('schedule.weekly' as never, { day: task.schedule.dayOfWeek, time: task.schedule.time })
  return ''
}

/** One per-project section: the shared cwd plus every task bound to it. */
interface TaskGroup {
  /** Workspace path the tasks run in; '' for tasks without a project binding. */
  cwd: string
  tasks: ScheduledTask[]
}

/**
 * Group tasks by their project directory so each project reads as one
 * section. Tasks without a project binding collapse into a single trailing
 * "no project" group instead of disappearing. Group order is stable
 * (alphabetical by folder name); within a group the store order is kept.
 */
function groupByProject(tasks: ScheduledTask[]): TaskGroup[] {
  const byProject = new Map<string, ScheduledTask[]>()
  for (const task of tasks) {
    const key = task.cwd || ''
    const existing = byProject.get(key)
    if (existing) existing.push(task)
    else byProject.set(key, [task])
  }
  const grouped = [...byProject.entries()]
    .filter(([cwd]) => cwd !== '')
    .sort((a, b) => (basename(a[0]) || a[0]).localeCompare(basename(b[0]) || b[0]))
    .map(([cwd, groupTasks]) => ({ cwd, tasks: groupTasks }))
  const ungrouped = byProject.get('')
  return ungrouped ? [...grouped, { cwd: '', tasks: ungrouped }] : grouped
}

const btn = 'rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors'
const input = 'mt-1 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream placeholder-cream-faint outline-none focus:border-accent/50'

/** Compact wall-clock duration for a finished run row. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export default function TasksPage() {
  const t = useT()
  const navigate = useNavigate()
  const scheduledTasks = useAppStore((s) => s.scheduledTasks)
  const recentWorkspaces = useAppStore((s) => s.recentWorkspaces)
  const language = useAppStore((s) => s.language)
  const [modalOpen, setModalOpen] = useState(false)
  /** Task being edited; null = creating a new one. */
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  /** Task ids whose run-history list is expanded. */
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())
  const [form, setForm] = useState({
    name: '', prompt: '', cwd: '',
    scheduleType: 'daily' as 'daily' | 'weekly' | 'weekdays' | 'interval',
    time: '09:00', dayOfWeek: 1, hours: 24, intervalMinutes: 30,
    intervalUnit: 'hour' as 'hour' | 'minute',
    notifyOnComplete: true,
    notifyChannel: 'system' as 'system' | 'feishu',
    permissionMode: 'default' as 'default' | 'readonly'
  })

  const projectName = (cwd: string) => basename(cwd) || cwd

  const openModal = () => {
    setEditingTask(null)
    setForm(f => ({ ...f, cwd: recentWorkspaces[0]?.displayPath ?? '', name: '', prompt: '', permissionMode: 'default', notifyChannel: 'system' }))
    setModalOpen(true)
  }

  /** Edit keeps the identity (id/createdAt) and pre-fills user-owned fields. */
  const openEdit = (task: ScheduledTask) => {
    setEditingTask(task)
    setForm({
      name: task.name,
      prompt: task.prompt,
      cwd: task.cwd,
      scheduleType: task.schedule.type,
      time: task.schedule.type === 'weekly' || task.schedule.type === 'weekdays' || task.schedule.type === 'daily' ? task.schedule.time : '09:00',
      dayOfWeek: task.schedule.type === 'weekly' ? task.schedule.dayOfWeek : 1,
      hours: task.schedule.type === 'interval' ? task.schedule.hours ?? 24 : 24,
      intervalMinutes: task.schedule.type === 'interval' ? task.schedule.minutes ?? 30 : 30,
      intervalUnit: task.schedule.type === 'interval' && task.schedule.minutes !== undefined ? 'minute' : 'hour',
      notifyOnComplete: task.notifyOnComplete,
      notifyChannel: task.notifyChannel === 'feishu' ? 'feishu' : 'system',
      permissionMode: task.permissionMode === 'readonly' ? 'readonly' : 'default'
    })
    setModalOpen(true)
  }

  // All mutations trust the Main-side TASKS_STATE_CHANGED broadcast: Main
  // applies the change and pushes the authoritative list BEFORE the invoke
  // resolves, so a local append/map here would double-apply (a saved task
  // used to appear twice).

  const handleSave = async () => {
    if (!form.name.trim() || !form.prompt.trim() || !form.cwd) return
    const schedule = form.scheduleType === 'daily'
      ? { type: 'daily' as const, time: form.time }
      : form.scheduleType === 'weekly'
        ? { type: 'weekly' as const, dayOfWeek: form.dayOfWeek, time: form.time }
        : form.scheduleType === 'weekdays'
          ? { type: 'weekdays' as const, time: form.time }
          : form.intervalUnit === 'minute'
            ? { type: 'interval' as const, minutes: form.intervalMinutes }
            : { type: 'interval' as const, hours: form.hours }
    const task: ScheduledTask = {
      // Editing keeps the original identity so the run ledger survives.
      id: editingTask?.id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: form.name.trim(), prompt: form.prompt.trim(), cwd: form.cwd,
      schedule, enabled: editingTask?.enabled ?? true,
      createdAt: editingTask?.createdAt ?? Date.now(), notifyOnComplete: form.notifyOnComplete,
      ...(form.notifyChannel === 'feishu' ? { notifyChannel: 'feishu' as const } : {}),
      ...(form.permissionMode === 'readonly' ? { permissionMode: 'readonly' as const } : {})
    }
    let result: Awaited<ReturnType<typeof window.electronAPI.saveTask>>
    try {
      result = await window.electronAPI.saveTask(task)
    } catch {
      result = { ok: false }
    }
    if (result.ok && result.task) {
      setModalOpen(false)
    } else {
      // Keep the modal open with the user's draft intact — closing silently
      // would make the task they just wrote vanish without a trace.
      showNotice('tasks.saveFailed')
    }
  }

  const handleToggle = async (task: ScheduledTask) => {
    try {
      const updated = await window.electronAPI.toggleTask(task.id, !task.enabled)
      if (!updated) showNotice('tasks.toggleFailed')
    } catch {
      showNotice('tasks.toggleFailed')
    }
  }

  const handleRunNow = async (task: ScheduledTask) => {
    setRunning(task.id)
    try {
      const result = await window.electronAPI.runTaskNow(task.id)
      if (result === 'ok') showNotice('tasks.runStarted')
      else if (result === 'running') showNotice('tasks.alreadyRunning')
      else showNotice('tasks.runFailed')
    } catch {
      showNotice('tasks.runFailed')
    } finally {
      setTimeout(() => setRunning(null), 3000)
    }
  }

  /**
   * Open the session a firing created. Live registry first; after a restart,
   * fall back to the durable history row of this task (task sessions are
   * titled after the task and live in the task's cwd) matched by run time.
   */
  const openRunEntry = (task: ScheduledTask, run: { sessionId?: string; startedAt: number }) => {
    const state = useAppStore.getState()
    if (run.sessionId && state.sessions.some((s) => s.id === run.sessionId)) {
      state.setCurrentSessionId(run.sessionId)
      navigate('/')
      return
    }
    const row = state.globalHistory.find(
      (entry) =>
        entry.title === task.name &&
        entry.cwd === task.cwd &&
        Math.abs(entry.timestamp - run.startedAt) < 60_000
    )
    if (row) {
      state.setPendingOpenHistory({ uuid: row.uuid, cwd: row.cwd })
      navigate('/')
    } else {
      showNotice('tasks.runSessionMissing')
    }
  }

  const openRunSession = (task: ScheduledTask) => {
    openRunEntry(task, { sessionId: task.lastRunSessionId, startedAt: task.lastRunAt ?? 0 })
  }

  const toggleRunHistory = (taskId: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  // Deleting a task is permanent and cannot be undone — two-stage confirm,
  // same pattern as deleting sessions and plugins.
  const deleteTaskConfirm = useConfirmId((id: string) => {
    void window.electronAPI
      .deleteTask(id)
      .then((ok) => {
        if (!ok) showNotice('tasks.deleteFailed')
      })
      .catch(() => showNotice('tasks.deleteFailed'))
  })

  // Esc closes the dialog; clicking the dimmed backdrop does too. Without
  // this, the only way out is the small ✕ in the corner.
  useEffect(() => {
    if (!modalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) setModalOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="app-drag flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <Clock size={15} className="text-accent" />
        <span className="text-[13px] font-medium text-cream">{t('tasks.title')}</span>
        <button onClick={openModal} className={`${btn} ml-auto flex items-center gap-1 bg-accent text-white hover:bg-accent-bright`}>
          <Plus size={12} /> {t('tasks.create')}
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[680px] space-y-3">
          {scheduledTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line py-16 text-center">
              <Clock size={28} className="mb-3 text-cream-faint/40" />
              <p className="text-[14px] font-medium text-cream-dim">{t('tasks.empty.title')}</p>
              <p className="mt-1 max-w-xs text-[12px] leading-5 text-cream-faint">{t('tasks.empty.subtitle')}</p>
              <button onClick={openModal} className={`${btn} mt-4 bg-accent text-white hover:bg-accent-bright`}>
                <Plus size={12} /> {t('tasks.create')}
              </button>
            </div>
          ) : (
            groupByProject(scheduledTasks).map(group => (
              <div key={group.cwd || '__ungrouped__'} className="space-y-3">
                <div className="flex items-center gap-1.5 px-1" title={group.cwd || undefined}>
                  <Folder size={12} className="shrink-0 text-accent" />
                  <span className="shrink-0 text-[12px] font-semibold text-cream-dim">
                    {group.cwd ? projectName(group.cwd) : t('tasks.ungrouped')}
                  </span>
                  {group.cwd && (
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-cream-faint">{group.cwd}</span>
                  )}
                  <span className="ml-auto shrink-0 rounded-full bg-overlay px-2 py-0.5 text-[10px] font-medium text-cream-faint">
                    {group.tasks.length}
                  </span>
                </div>
                {group.tasks.map(task => (
                  <div key={task.id} className={`rounded-xl border p-4 transition-colors ${task.enabled ? 'border-line bg-ink-850' : 'border-line/50 bg-ink-850/50 opacity-60'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-[14px] font-medium ${task.enabled ? 'text-cream' : 'text-cream-faint'}`}>{task.name}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${task.enabled ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' : 'bg-overlay text-cream-faint'}`}>
                            {task.enabled ? t('sidebar.taskEnabled') : t('sidebar.taskDisabled')}
                          </span>
                          {task.permissionMode === 'readonly' && (
                            <span className="rounded-full bg-overlay px-2 py-0.5 text-[10px] font-medium text-cream-faint">
                              {t('tasks.permissionReadonly')}
                            </span>
                          )}
                          {!task.enabled && (task.consecutiveFailures ?? 0) > 0 && (
                            <span
                              title={task.lastFailureReason ? `${t('tasks.autoDisabledHint')} · ${t(`tasks.failure.${task.lastFailureReason}` as I18nKey)}` : t('tasks.autoDisabledHint')}
                              className="rounded-full bg-red-500/12 px-2 py-0.5 text-[10px] font-medium text-red-500"
                            >
                              {t('tasks.failedBadge', { count: task.consecutiveFailures ?? 0 })}
                            </span>
                          )}
                          {task.notifyChannel === 'feishu' && (
                            <span className="rounded-full bg-overlay px-2 py-0.5 text-[10px] font-medium text-cream-faint">
                              {t('tasks.notifyFeishu')}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-cream-faint">{task.prompt}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-cream-faint">
                          <span className="flex items-center gap-1"><Calendar size={11} /> {scheduleText(task, t)}</span>
                          <span className="flex items-center gap-1"><Clock size={11} /> {projectName(task.cwd)}</span>
                          {task.lastRunAt && (
                            <span title={new Date(task.lastRunAt).toLocaleString()}>
                              {t('tasks.lastRun')}: {formatRelativeTime(task.lastRunAt, language)}
                            </span>
                          )}
                        </div>
                        {(task.runs?.length ?? 0) > 0 && (
                          <div className="mt-2">
                            <button
                              onClick={() => toggleRunHistory(task.id)}
                              className="flex items-center gap-1 text-[11px] text-cream-faint transition-colors hover:text-cream-dim"
                            >
                              {expandedRuns.has(task.id) ? <ChevronDown size={11} strokeWidth={1.5} /> : <ChevronRight size={11} strokeWidth={1.5} />}
                              {t('tasks.runHistory')} · {task.runs?.length}
                            </button>
                            {expandedRuns.has(task.id) && (
                              <div className="mt-1 space-y-0.5">
                                {(task.runs ?? []).map((run, index) => {
                                  const live = !run.finishedAt
                                  const failed = run.outcome === 'failed'
                                  return (
                                    <div
                                      key={run.sessionId ?? `${run.startedAt}-${index}`}
                                      onClick={() => !live && openRunEntry(task, run)}
                                      className={`group flex items-center gap-2 rounded-md px-1.5 py-1 text-[11px] ${live ? 'text-cream-faint' : 'cursor-pointer text-cream-dim transition-colors hover:bg-overlay'}`}
                                    >
                                      {live ? (
                                        <Loader2 size={11} className="shrink-0 animate-spin" />
                                      ) : failed ? (
                                        <span className="shrink-0 font-medium text-red-500">✕</span>
                                      ) : (
                                        <span className="shrink-0 font-medium text-emerald-500">✓</span>
                                      )}
                                      <span className="shrink-0">{formatRelativeTime(run.startedAt, language)}</span>
                                      {run.finishedAt && (
                                        <span className="shrink-0 text-cream-faint">{formatDuration(run.finishedAt - run.startedAt)}</span>
                                      )}
                                      {failed && run.reason && (
                                        <span className="min-w-0 truncate text-red-400">{t(`tasks.failure.${run.reason}`)}</span>
                                      )}
                                      {!live && (
                                        <MessageSquare size={11} className="ml-auto shrink-0 text-cream-faint opacity-0 transition-opacity group-hover:opacity-100" />
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button onClick={() => openRunSession(task)}
                          title={t('tasks.openRun')}
                          className="rounded-lg p-1.5 text-cream-dim transition-colors hover:bg-overlay hover:text-accent">
                          <MessageSquare size={14} />
                        </button>
                        <button onClick={() => openEdit(task)}
                          title={t('tasks.edit')}
                          className="rounded-lg p-1.5 text-cream-dim transition-colors hover:bg-overlay hover:text-accent">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => void handleRunNow(task)} disabled={!task.enabled || running === task.id}
                          title={t('sidebar.taskRunNow')}
                          className="rounded-lg p-1.5 text-cream-dim transition-colors hover:bg-overlay hover:text-accent disabled:opacity-30">
                          {running === task.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                        </button>
                        <button onClick={() => void handleToggle(task)} title={task.enabled ? t('sidebar.taskEnabled') : t('sidebar.taskDisabled')}
                          className={`relative h-5 w-9 rounded-full transition-colors ${task.enabled ? 'bg-emerald-500' : 'bg-line-strong'}`}>
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${task.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                        </button>
                        <button onClick={() => deleteTaskConfirm.click(task.id)}
                          title={deleteTaskConfirm.confirmingId === task.id ? t('tasks.deleteConfirm') : t('sidebar.deleteSession')}
                          className={`rounded-lg p-1.5 transition-colors ${
                            deleteTaskConfirm.confirmingId === task.id
                              ? 'bg-red-500/15 text-red-500'
                              : 'text-cream-faint hover:bg-red-500/10 hover:text-red-500'
                          }`}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-6 backdrop-blur-[2px]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false)
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-line bg-ink-850 p-5 shadow-pop">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[14px] font-semibold text-cream">
                {editingTask ? t('tasks.editTitle') : t('tasks.create')}
              </span>
              <button onClick={() => setModalOpen(false)} className="text-cream-faint hover:text-cream"><Plus size={14} className="rotate-45" /></button>
            </div>
            <div className="space-y-3">
              <label className="block text-[11px] text-cream-faint">
                {t('sidebar.taskName')}
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={input} placeholder={t('sidebar.taskNamePh')} />
              </label>
              <label className="block text-[11px] text-cream-faint">
                {t('sidebar.taskPrompt')}
                <textarea value={form.prompt} onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))} rows={3} className={`${input} resize-none py-2`} placeholder={t('sidebar.taskPromptPh')} />
              </label>
              <label className="block text-[11px] text-cream-faint">
                {t('tasks.project')}
                <select value={form.cwd} onChange={e => setForm(f => ({ ...f, cwd: e.target.value }))} className={input + ' h-8'}>
                  <option value="">{t('sidebar.selectProject')}</option>
                  {recentWorkspaces.map(w => <option key={w.id} value={w.displayPath}>{basename(w.displayPath) || w.displayPath}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-cream-faint">
                  {t('sidebar.taskSchedule')}
                  <select value={form.scheduleType} onChange={e => setForm(f => ({ ...f, scheduleType: e.target.value as typeof form.scheduleType }))} className={input + ' h-8'}>
                    <option value="daily">{t('schedule.typeDaily')}</option>
                    <option value="weekdays">{t('schedule.typeWeekdays')}</option>
                    <option value="weekly">{t('schedule.typeWeekly')}</option>
                    <option value="interval">{t('schedule.typeInterval')}</option>
                  </select>
                </label>
                {form.scheduleType !== 'interval' && (
                  <label className="block text-[11px] text-cream-faint">{t('tasks.time')}
                    <input type="time" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} className={input + ' h-8'} />
                  </label>
                )}
                {form.scheduleType === 'interval' && (
                  <label className="block text-[11px] text-cream-faint">
                    {t('sidebar.taskSchedule')}
                    <select value={form.intervalUnit} onChange={e => setForm(f => ({ ...f, intervalUnit: e.target.value as 'hour' | 'minute' }))} className={input + ' h-8'}>
                      <option value="minute">{t('schedule.typeIntervalMinutes')}</option>
                      <option value="hour">{t('schedule.typeInterval')}</option>
                    </select>
                  </label>
                )}
                {form.scheduleType === 'interval' && (
                  <label className="block text-[11px] text-cream-faint">
                    {t('tasks.time')}
                    <input type="number" min={1} max={form.intervalUnit === 'minute' ? 10080 : 168}
                      value={form.intervalUnit === 'minute' ? form.intervalMinutes : form.hours}
                      onChange={e => setForm(f => f.intervalUnit === 'minute'
                        ? ({ ...f, intervalMinutes: Number(e.target.value) || 30 })
                        : ({ ...f, hours: Number(e.target.value) || 24 }))}
                      className={input + ' h-8'} />
                  </label>
                )}
                {form.scheduleType === 'weekly' && (
                  <label className="block text-[11px] text-cream-faint">{t('tasks.day')}
                    <select value={form.dayOfWeek} onChange={e => setForm(f => ({ ...f, dayOfWeek: Number(e.target.value) }))} className={input + ' h-8'}>
                      <option value={1}>{t('schedule.dayMon')}</option><option value={2}>{t('schedule.dayTue')}</option><option value={3}>{t('schedule.dayWed')}</option>
                      <option value={4}>{t('schedule.dayThu')}</option><option value={5}>{t('schedule.dayFri')}</option><option value={6}>{t('schedule.daySat')}</option><option value={0}>{t('schedule.daySun')}</option>
                    </select>
                  </label>
                )}
              </div>
              <label className="block text-[11px] text-cream-faint">
                {t('tasks.permission')}
                <select value={form.permissionMode} onChange={e => setForm(f => ({ ...f, permissionMode: e.target.value as 'default' | 'readonly' }))} className={input + ' h-8'}>
                  <option value="default">{t('tasks.permissionDefault')}</option>
                  <option value="readonly">{t('tasks.permissionReadonly')}</option>
                </select>
              </label>
              <label className="block text-[11px] text-cream-faint">
                {t('tasks.notifyChannel')}
                <select value={form.notifyChannel} onChange={e => setForm(f => ({ ...f, notifyChannel: e.target.value as 'system' | 'feishu' }))} className={input + ' h-8'}>
                  <option value="system">{t('tasks.notifySystem')}</option>
                  <option value="feishu">{t('tasks.notifyFeishu')}</option>
                </select>
              </label>
              {form.notifyChannel === 'feishu' && (
                <p className="text-[11px] leading-4 text-cream-faint">{t('tasks.notifyFeishuHint')}</p>
              )}
              <label className="mt-1 flex cursor-pointer items-center gap-2 text-[11px] text-cream-faint">
                <input
                  type="checkbox"
                  checked={form.notifyOnComplete}
                  onChange={(e) => setForm(f => ({ ...f, notifyOnComplete: e.target.checked }))}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                {t('tasks.notifyOnComplete')}
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setModalOpen(false)} className={`${btn} border border-line text-cream-dim hover:text-cream`}>{t('home.cancel')}</button>
              <button onClick={() => void handleSave()} disabled={!form.name.trim() || !form.prompt.trim() || !form.cwd}
                className={`${btn} bg-accent text-white disabled:opacity-40`}>
                {editingTask ? t('tasks.save') : t('tasks.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
