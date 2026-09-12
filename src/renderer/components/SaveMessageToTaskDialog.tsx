import { useEffect, useState } from 'react'
import { CalendarClock, Check, Loader2, X } from 'lucide-react'
import { ScheduledTask } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { showNotice } from '../lib/notice'

/**
 * Explicit chat → scheduled-task handoff, mirroring SaveMessageToBoardDialog.
 * The message the user acted on pre-fills the prompt; the person picks the
 * project, schedule and name before anything is created. Main-side TASKS_SAVE
 * validation is the authority — this dialog only shapes the draft.
 */
export function SaveMessageToTaskDialog({
  content,
  onClose
}: {
  content: string
  onClose: () => void
}) {
  const t = useT()
  const recentWorkspaces = useAppStore((s) => s.recentWorkspaces)
  const [name, setName] = useState(content.trim().split('\n')[0].slice(0, 30) || '')
  const [prompt, setPrompt] = useState(content.slice(0, 2_000))
  const [cwd, setCwd] = useState(recentWorkspaces[0]?.displayPath ?? '')
  const [scheduleType, setScheduleType] = useState<'daily' | 'weekly' | 'interval'>('daily')
  const [time, setTime] = useState('09:00')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [hours, setHours] = useState(24)
  const [notifyOnComplete, setNotifyOnComplete] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const create = async () => {
    if (!cwd || busy) return
    setBusy(true)
    setError(null)
    const schedule =
      scheduleType === 'daily'
        ? { type: 'daily' as const, time }
        : scheduleType === 'weekly'
          ? { type: 'weekly' as const, dayOfWeek, time }
          : { type: 'interval' as const, hours }
    const task: ScheduledTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: (name.trim() || content.trim().split('\n')[0].slice(0, 30) || t('tasks.fromChat.create')).slice(0, 60),
      prompt: prompt.trim(),
      cwd,
      schedule,
      enabled: true,
      createdAt: Date.now(),
      notifyOnComplete
    }
    try {
      const result = await window.electronAPI.saveTask(task)
      if (result.ok) {
        showNotice('tasks.fromChat.created')
        onClose()
        return
      }
      setError(t('tasks.fromChat.createFailed'))
    } catch {
      setError(t('tasks.fromChat.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  const input = 'mt-1 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream placeholder-cream-faint outline-none focus:border-accent/50'
  const valid = !!cwd && !!prompt.trim()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/75 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('tasks.fromChat.dialogTitle')}
        className="w-full max-w-[440px] rounded-2xl border border-line bg-ink-900 p-5 shadow-pop"
      >
        <header className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <CalendarClock size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-cream">{t('tasks.fromChat.dialogTitle')}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            title={t('boards.cancel')}
            className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </header>

        {recentWorkspaces.length === 0 ? (
          <p className="mt-5 rounded-xl border border-line bg-ink-850 px-3 py-2.5 text-xs leading-5 text-cream-dim">
            {t('tasks.fromChat.noProjects')}
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-cream-faint">{t('tasks.fromChat.pickProject')}</span>
              <select
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                disabled={busy}
                className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream outline-none focus:border-accent/50 disabled:opacity-50"
              >
                {recentWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.displayPath}>
                    {workspace.displayPath}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-cream-faint">{t('sidebar.taskName')}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                disabled={busy}
                className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream outline-none focus:border-accent/50 disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-cream-faint">{t('sidebar.taskPrompt')}</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                disabled={busy}
                className="w-full resize-none rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] leading-5 text-cream outline-none focus:border-accent/50 disabled:opacity-50"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-cream-faint">{t('sidebar.taskSchedule')}</span>
                <select
                  value={scheduleType}
                  onChange={(event) => setScheduleType(event.target.value as 'daily' | 'weekly' | 'interval')}
                  disabled={busy}
                  className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream outline-none focus:border-accent/50 disabled:opacity-50"
                >
                  <option value="daily">{t('schedule.typeDaily')}</option>
                  <option value="weekly">{t('schedule.typeWeekly')}</option>
                  <option value="interval">{t('schedule.typeInterval')}</option>
                </select>
              </label>
              {scheduleType === 'daily' || scheduleType === 'weekly' ? (
                <label className="block">
                  <span className="mb-1 block text-[11px] text-cream-faint">{t('tasks.time')}</span>
                  <input
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    disabled={busy}
                    className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream outline-none focus:border-accent/50 disabled:opacity-50"
                  />
                </label>
              ) : (
                <label className="block">
                  <span className="mb-1 block text-[11px] text-cream-faint">{t('tasks.hours')}</span>
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={hours}
                    onChange={(event) => setHours(Number(event.target.value) || 24)}
                    disabled={busy}
                    className={input + ' h-[30px]'}
                  />
                </label>
              )}
              {scheduleType === 'weekly' && (
                <label className="block">
                  <span className="mb-1 block text-[11px] text-cream-faint">{t('tasks.day')}</span>
                  <select
                    value={dayOfWeek}
                    onChange={(event) => setDayOfWeek(Number(event.target.value))}
                    disabled={busy}
                    className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream outline-none focus:border-accent/50 disabled:opacity-50"
                  >
                    <option value={1}>{t('schedule.dayMon')}</option>
                    <option value={2}>{t('schedule.dayTue')}</option>
                    <option value={3}>{t('schedule.dayWed')}</option>
                    <option value={4}>{t('schedule.dayThu')}</option>
                    <option value={5}>{t('schedule.dayFri')}</option>
                    <option value={6}>{t('schedule.daySat')}</option>
                    <option value={0}>{t('schedule.daySun')}</option>
                  </select>
                </label>
              )}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-cream-faint">
              <input
                type="checkbox"
                checked={notifyOnComplete}
                onChange={(event) => setNotifyOnComplete(event.target.checked)}
                disabled={busy}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              {t('tasks.notifyOnComplete')}
            </label>
          </div>
        )}

        {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}

        <footer className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
          >
            {t('boards.cancel')}
          </button>
          {recentWorkspaces.length > 0 && (
            <button
              onClick={() => void create()}
              disabled={!valid || busy}
              className="flex items-center gap-1 rounded-full bg-cream px-3 py-1.5 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              {busy ? t('tasks.fromChat.creating') : t('tasks.fromChat.create')}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
