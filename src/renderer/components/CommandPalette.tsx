import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CalendarClock,
  Clock,
  FileDown,
  History,
  Library,
  Link2,
  MessageSquare,
  Plus,
  Puzzle,
  Search,
  Settings,
  SquareKanban,
  SunMoon,
  type LucideIcon
} from 'lucide-react'
import type { HistorySessionDescriptor } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import {
  buildPaletteItems,
  filterPaletteItems,
  type PaletteActionSource,
  type PaletteItem,
  type PaletteItemKind,
  type PalettePageSource,
  type PaletteSessionSource
} from '../lib/commandPalette'
import { recordDurableUuid } from '../lib/sessionRegistry'
import { formatRelativeTime } from '../lib/time'

/** Payload for opening a durable history row (resolved by uuid in App). */
export interface PaletteOpenTarget {
  uuid: string
  cwd: string
}

/**
 * Execution surface. The palette is presentation-only: App owns the router,
 * the store and IPC, so every effect crosses this prop boundary.
 */
export interface CommandPaletteHandlers {
  navigate: (path: string) => void
  newChat: () => void
  toggleTheme: () => void
  exportHtml: (sessionId: string) => void
  openSession: (sessionId: string) => void
  openHistory: (target: PaletteOpenTarget) => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  handlers: CommandPaletteHandlers
}

const PAGE_ICONS: Record<string, LucideIcon> = {
  chat: MessageSquare,
  boards: SquareKanban,
  skills: Library,
  connections: Link2,
  tasks: Clock,
  plugins: Puzzle,
  settings: Settings
}

const GROUP_ORDER: PaletteItemKind[] = ['page', 'action', 'session', 'task']

/**
 * Global ⌘K command palette: one entry point to jump to pages, open sessions
 * and run quick actions. A hand-rolled fixed overlay (a palette is not an
 * anchored menu, so MenuPortal does not fit): dimmed backdrop, top-centered
 * panel, keyboard-first — ↑/↓ move with wrap, Enter executes, Esc closes,
 * hover tracks the active row.
 */
export default function CommandPalette({ open, onClose, handlers }: CommandPaletteProps) {
  const t = useT()
  // Atomic slices — palette data sources, read directly from the store.
  const sessions = useAppStore((s) => s.sessions)
  const sessionRecords = useAppStore((s) => s.sessionRecords)
  const globalHistory = useAppStore((s) => s.globalHistory)
  const scheduledTasks = useAppStore((s) => s.scheduledTasks)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const language = useAppStore((s) => s.language)
  const archivedSessionIds = useAppStore((s) => s.archivedSessionIds)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Fresh landing view on every open.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  const archivedSet = useMemo(() => new Set(archivedSessionIds), [archivedSessionIds])
  const recordByRuntimeId = useMemo(
    () =>
      new Map(
        sessionRecords
          .filter((record) => record.runtimeSessionId)
          .map((record) => [record.runtimeSessionId as string, record])
      ),
    [sessionRecords]
  )

  // Raw session candidates (live + workspace history + cross-project rows).
  // Dedupe against live rows/resume forks/archives happens in buildPaletteItems.
  const sessionSources = useMemo<PaletteSessionSource[]>(() => {
    const sources: PaletteSessionSource[] = []
    for (const session of sessions) {
      const uuid = recordDurableUuid(recordByRuntimeId.get(session.id))
      sources.push({
        origin: 'live',
        id: session.id,
        uuid,
        title: session.title,
        timestamp: session.createdAt,
        cwd: session.cwd,
        archived: archivedSet.has(session.id) || (uuid !== null && archivedSet.has(uuid))
      })
    }
    for (const record of sessionRecords) {
      if (record.isLive || !record.history) continue
      const info: HistorySessionDescriptor = record.history
      sources.push({
        origin: 'history',
        id: info.id,
        uuid: info.uuid,
        title: info.title,
        timestamp: info.timestamp,
        cwd: record.workspaceRealPath,
        archived: archivedSet.has(info.uuid)
      })
    }
    for (const row of globalHistory) {
      sources.push({
        origin: 'global',
        id: row.uuid,
        uuid: row.uuid,
        title: row.title,
        timestamp: row.timestamp,
        cwd: row.cwd,
        archived: archivedSet.has(row.uuid)
      })
    }
    return sources
  }, [sessions, sessionRecords, globalHistory, archivedSet, recordByRuntimeId])

  const pages = useMemo<PalettePageSource[]>(
    () => [
      { id: 'chat', path: '/', title: t('sidebar.chat') },
      { id: 'boards', path: '/boards', title: t('sidebar.boards') },
      { id: 'skills', path: '/skills', title: t('sidebar.skills') },
      { id: 'connections', path: '/connections', title: t('sidebar.connections') },
      { id: 'tasks', path: '/tasks', title: t('sidebar.tasks') },
      { id: 'plugins', path: '/plugins', title: t('sidebar.plugins') },
      { id: 'settings', path: '/settings', title: t('sidebar.settings') }
    ],
    [t]
  )

  // Availability is data, not UI state: export only exists with an active session.
  const actions = useMemo<PaletteActionSource[]>(() => {
    const list: PaletteActionSource[] = [
      { id: 'newChat', title: t('palette.action.newChat') },
      { id: 'toggleTheme', title: t('palette.action.toggleTheme') }
    ]
    if (currentSessionId) {
      list.push({ id: 'exportHtml', title: t('palette.action.exportHtml'), sessionId: currentSessionId })
    }
    return list
  }, [t, currentSessionId])

  const items = useMemo(
    () =>
      buildPaletteItems({
        pages,
        actions,
        sessions: sessionSources,
        tasks: scheduledTasks.map((task) => ({ id: task.id, name: task.name, cwd: task.cwd })),
        untitledLabel: t('history.untitled')
      }),
    [pages, actions, sessionSources, scheduledTasks, t]
  )

  const filtered = useMemo(() => filterPaletteItems(items, query), [items, query])

  // Display groups in fixed order; the flat list carries the active index.
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((kind) => ({
        kind,
        label:
          kind === 'page'
            ? t('palette.groupPages')
            : kind === 'action'
              ? t('palette.groupActions')
              : kind === 'session'
                ? t('palette.groupSessions')
                : t('palette.groupTasks'),
        items: filtered.filter((item) => item.kind === kind)
      })).filter((group) => group.items.length > 0),
    [filtered, t]
  )
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])

  // Keep the active row inside whatever list is showing.
  useEffect(() => {
    setActiveIndex((index) => (index < flat.length ? index : Math.max(0, flat.length - 1)))
  }, [flat.length])

  // Scroll the active row into view (nearest — never yanks the panel itself).
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, flat.length])

  const execute = (item: PaletteItem) => {
    const exec = item.exec
    switch (exec.type) {
      case 'navigate':
        handlers.navigate(exec.path)
        break
      case 'newChat':
        handlers.newChat()
        break
      case 'toggleTheme':
        handlers.toggleTheme()
        break
      case 'exportHtml':
        if (exec.sessionId) handlers.exportHtml(exec.sessionId)
        break
      case 'openSession':
        handlers.openSession(exec.sessionId)
        break
      case 'openHistory':
        handlers.openHistory({ uuid: exec.uuid, cwd: exec.cwd })
        break
    }
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flat.length > 0) setActiveIndex((index) => (index + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length > 0) setActiveIndex((index) => (index - 1 + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[activeIndex]
      if (item) execute(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const iconFor = (item: PaletteItem): LucideIcon => {
    if (item.kind === 'session') return History
    if (item.kind === 'task') return CalendarClock
    if (item.kind === 'action') {
      if (item.exec.type === 'newChat') return Plus
      if (item.exec.type === 'toggleTheme') return SunMoon
      return FileDown
    }
    return PAGE_ICONS[item.id.slice('page:'.length)] ?? Search
  }

  const hintFor = (item: PaletteItem): string | null => {
    if (item.kind === 'session' && item.timestamp !== undefined) {
      // Same shape as the sidebar's foreign-workspace rows: project · age.
      return [item.projectName, formatRelativeTime(item.timestamp, language)]
        .filter(Boolean)
        .join(' · ')
    }
    return null
  }

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[70] bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.placeholder')}
        className="fixed left-1/2 top-[15vh] w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-ink-850 shadow-pop"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={15} className="shrink-0 text-cream-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            spellCheck={false}
            className="h-12 w-full bg-transparent text-[13px] text-cream outline-none placeholder:text-cream-faint"
          />
          <span className="kbd shrink-0">esc</span>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto overscroll-contain p-1.5">
          {flat.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-cream-faint">
              <Search size={18} strokeWidth={1.5} />
              <span className="text-[13px]">{t('palette.noResults')}</span>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.kind}>
                <div className="sticky top-0 z-10 bg-ink-850 px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const index = flat.indexOf(item)
                  const active = index === activeIndex
                  const Icon = iconFor(item)
                  const hint = hintFor(item)
                  return (
                    <div
                      key={item.id}
                      data-active={active || undefined}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => execute(item)}
                      className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-150 ${
                        active ? 'bg-overlay' : ''
                      }`}
                    >
                      <Icon
                        size={14}
                        strokeWidth={1.75}
                        className={`shrink-0 ${active ? 'text-cream' : 'text-cream-faint'}`}
                      />
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          active ? 'font-medium text-cream' : 'text-cream-dim'
                        }`}
                      >
                        {item.title}
                      </span>
                      {item.exec.type === 'newChat' && <span className="kbd shrink-0">⌘N</span>}
                      {hint && (
                        <span className="max-w-[45%] shrink-0 truncate text-[11px] text-cream-faint">
                          {hint}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-end border-t border-line px-4 py-1.5">
          <span className="text-[10.5px] text-cream-faint">{t('palette.hints')}</span>
        </div>
      </div>
    </div>,
    document.body
  )
}
