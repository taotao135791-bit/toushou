import { useEffect, useState } from 'react'
import { Plus, Play, Trash2, Clock, Calendar, Folder, Loader2 } from 'lucide-react'
import { ScheduledTask } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { showNotice } from '../lib/notice'
import { useConfirmId } from '../lib/confirmClick'
import { basename } from '../lib/path'

function scheduleText(task: ScheduledTask, t: (key: never, vars?: Record<string, string | number>) => string): string {
  if (task.schedule.type === 'daily') return t('schedule.daily' as never, { time: task.schedule.time })
  if (task.schedule.type === 'interval') return t('schedule.interval' as never, { hours: task.schedule.hours })
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

export default function TasksPage() {
  const t = useT()
  const scheduledTasks = useAppStore((s) => s.scheduledTasks)
  const recentWorkspaces = useAppStore((s) => s.recentWorkspaces)
  const [modalOpen, setModalOpen] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '', prompt: '', cwd: '',
    scheduleType: 'daily' as 'daily' | 'weekly' | 'interval',
    time: '09:00', dayOfWeek: 1, hours: 24,
    notifyOnComplete: true
  })

  const projectName = (cwd: string) => basename(cwd) || cwd

  const openModal = () => {
    setForm(f => ({ ...f, cwd: recentWorkspaces[0]?.displayPath ?? '', name: '', prompt: '' }))
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
        : { type: 'interval' as const, hours: form.hours }
    const task: ScheduledTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: form.name.trim(), prompt: form.prompt.trim(), cwd: form.cwd,
      schedule, enabled: true, createdAt: Date.now(), notifyOnComplete: form.notifyOnComplete
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

  const btn = 'rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors'
  const input = 'mt-1 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream placeholder-cream-faint outline-none focus:border-accent/50'

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
                          {!task.enabled && (task.consecutiveFailures ?? 0) > 0 && (
                            <span
                              title={t('tasks.autoDisabledHint')}
                              className="rounded-full bg-red-500/12 px-2 py-0.5 text-[10px] font-medium text-red-500"
                            >
                              {t('tasks.failedBadge', { count: task.consecutiveFailures ?? 0 })}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-cream-faint">{task.prompt}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-cream-faint">
                          <span className="flex items-center gap-1"><Calendar size={11} /> {scheduleText(task, t)}</span>
                          <span className="flex items-center gap-1"><Clock size={11} /> {projectName(task.cwd)}</span>
                          {task.lastRunAt && <span>{t('tasks.lastRun')}: {new Date(task.lastRunAt).toLocaleString()}</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
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
              <span className="text-[14px] font-semibold text-cream">{t('tasks.create')}</span>
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
                  {recentWorkspaces.map(w => <option key={w.id} value={w.displayPath}>{w.displayPath}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-cream-faint">
                  {t('sidebar.taskSchedule')}
                  <select value={form.scheduleType} onChange={e => setForm(f => ({ ...f, scheduleType: e.target.value as typeof form.scheduleType }))} className={input + ' h-8'}>
                    <option value="daily">{t('schedule.typeDaily')}</option>
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
                  <label className="block text-[11px] text-cream-faint">{t('tasks.hours')}
                    <input type="number" min={1} max={168} value={form.hours} onChange={e => setForm(f => ({ ...f, hours: Number(e.target.value) || 24 }))} className={input + ' h-8'} />
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
                className={`${btn} bg-accent text-white disabled:opacity-40`}>{t('tasks.create')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
