import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  MessageSquare,
  Puzzle,
  SquareKanban,
  FolderOpen,
  AlertCircle,
  Library,
  Trash2,
  Sun,
  Moon,
  Search,
  Settings,
  X,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Loader2
} from 'lucide-react'
import { HistorySessionDescriptor } from '@shared/types'
import { MessageLike, useAppStore } from '../store'
import { useT } from '../i18n'
import { useNotice } from '../lib/notice'
import { recordsForWorkspace } from '../lib/sessionRegistry'
import { formatRelativeTime } from '../lib/time'
import { getSessionStatus } from '../lib/sessionStatus'
import { basename } from '../lib/path'
import { useConfirmId } from '../lib/confirmClick'
import Logo from './Logo'

const EMPTY_MESSAGES: Record<string, MessageLike[]> = {}

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const t = useT()
  // Atomic slices: streaming message deltas land only while a search is open
  // (the search reads transcript tails), never on the default grouped view.
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const cliAvailable = useAppStore((s) => s.cliAvailable)
  const sessionRecords = useAppStore((s) => s.sessionRecords)
  const language = useAppStore((s) => s.language)
  const theme = useAppStore((s) => s.theme)
  const busy = useAppStore((s) => s.busy)
  const pinnedSessionIds = useAppStore((s) => s.pinnedSessionIds)
  const archivedSessionIds = useAppStore((s) => s.archivedSessionIds)
  const unreadSessionIds = useAppStore((s) => s.unreadSessionIds)
  const uiRequests = useAppStore((s) => s.uiRequests)
  const historyLoading = useAppStore((s) => s.historyLoading)
  const recentProjects = useAppStore((s) => s.recentProjects)
  const recentWorkspaces = useAppStore((s) => s.recentWorkspaces)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const activateRecentWorkspace = useAppStore((s) => s.activateRecentWorkspace)
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId)
  const setSessions = useAppStore((s) => s.setSessions)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const setTheme = useAppStore((s) => s.setTheme)
  const togglePinSession = useAppStore((s) => s.togglePinSession)
  const setSessionArchived = useAppStore((s) => s.setSessionArchived)
  const addSession = useAppStore((s) => s.addSession)
  const setMessages = useAppStore((s) => s.setMessages)
  const loadHistorySessions = useAppStore((s) => s.loadHistorySessions)
  const removeHistorySession = useAppStore((s) => s.removeHistorySession)
  const setRecentProjects = useAppStore((s) => s.setRecentProjects)
  const setRecentWorkspaces = useAppStore((s) => s.setRecentWorkspaces)
  const removeRecentProject = useAppStore((s) => s.removeRecentProject)
  const setSetupComplete = useAppStore((s) => s.setSetupComplete)

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [projectsExpanded, setProjectsExpanded] = useState(false)
  const [resumingHistoryId, setResumingHistoryId] = useState<string | null>(null)
  const [restoreFailedHistoryId, setRestoreFailedHistoryId] = useState<string | null>(null)
  const [deleteFailedHistoryId, setDeleteFailedHistoryId] = useState<string | null>(null)
  const notice = useNotice()
  const searching = query.trim().length > 0
  const searchMessages = useAppStore((s) => (searching ? s.messages : EMPTY_MESSAGES))
  // One-time bootstrap of the most-recent workspace: only before the initial
  // hydration completes. A user explicitly clearing the current workspace must
  // NOT be yanked back to projects[0]. This effect runs ONCE on mount (deps
  // are the stable store setters) — re-reading the persistence store on every
  // `currentWorkspace` change was the MRU race: a stale read could clobber the
  // on-disk MRU with a single-entry list mid-hydration.
  const hydratedRecent = useRef(false)

  useEffect(() => {
    window.electronAPI.listRecentWorkspaces().then((workspaces) => {
      setRecentWorkspaces(workspaces)
      if (hydratedRecent.current) return
      hydratedRecent.current = true
      if (workspaces.length > 0 && !useAppStore.getState().currentWorkspace) {
        void activateRecentWorkspace(workspaces[0].id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activateRecentWorkspace, setRecentProjects])

  // Load the persisted session history on startup and whenever the workspace changes
  useEffect(() => {
    void loadHistorySessions(currentWorkspace?.id ?? null)
  }, [currentWorkspace, loadHistorySessions])

  const handleSelectProject = async () => {
    await selectWorkspace()
  }

  // Switching workspaces reloads the session history via the currentWorkspace effect
  const handleSwitchProject = (path: string) => {
    const workspace = recentWorkspaces.find((entry) => entry.displayPath === path)
    if (!workspace) return
    if (path === currentWorkspace?.realPath) return
    void activateRecentWorkspace(workspace.id)
  }

  const handleDeleteSession = (id: string) => {
    window.electronAPI.killSession(id)
    setSessions(sessions.filter((s) => s.id !== id))
    if (currentSessionId === id) {
      setCurrentSessionId(null)
    }
    // The killed session's file may now appear in the on-disk history
    void loadHistorySessions(currentWorkspace?.id ?? null)
  }

  const handleResumeHistory = async (info: HistorySessionDescriptor) => {
    // While the list is reloading for a new workspace its entries may still
    // belong to the previous project — resuming one would use the new grant.
    if (resumingHistoryId || historyLoading || !currentWorkspace) return
    const grant = currentWorkspace
    setResumingHistoryId(info.id)
    setRestoreFailedHistoryId(null)
    try {
      const result = await window.electronAPI.resumeSession(grant.id, info.id)
      if (!result) {
        setRestoreFailedHistoryId(info.id)
        console.error('Failed to resume history session:', info.id)
        return
      }
      const { session, messages: restored, historicalAgents } = result
      // The main process titles a resumed session after the project dir;
      // prefer the richer title from the history entry when there is one.
      const projectName = basename(grant.displayPath)
      const title =
        (!session.title || session.title === projectName) && info.title !== 'Untitled'
          ? info.title
          : session.title
      addSession({ ...session, title })
      setMessages(session.id, restored)
      // A resumed session is now represented by its live row. Its old opaque
      // history capability must not leave a duplicate historical row behind.
      removeHistorySession(info.id)
      // Fold durable historical agents into the projection — live roster is
      // empty for these. Unknown stays unknown until durable data proves more.
      useAppStore.getState().applyHistoricalAgents(session.id, historicalAgents ?? [])
      setCurrentSessionId(session.id)
      navigate('/')
    } finally {
      setResumingHistoryId(null)
    }
  }

  const handleDeleteHistory = async (info: HistorySessionDescriptor) => {
    if (historyLoading || !currentWorkspace) return
    const ok = await window.electronAPI.deleteSessionFile(currentWorkspace.id, info.id)
    // Only the history entry goes away on success — a failed delete keeps the
    // item and surfaces a user-visible error (never silent success).
    if (ok) {
      setDeleteFailedHistoryId(null)
      removeHistorySession(info.id)
    } else {
      setDeleteFailedHistoryId(info.id)
      setTimeout(() => setDeleteFailedHistoryId((id) => (id === info.id ? null : id)), 3000)
    }
  }

  const deleteHistoryConfirm = useConfirmId((id: string) => {
    setDeleteFailedHistoryId(null)
    const info = visibleHistory.find((entry) => entry.id === id)
    if (info) void handleDeleteHistory(info)
  })
  const deleteSessionConfirm = useConfirmId((id: string) => handleDeleteSession(id))

  const pinnedSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds])
  const archivedSet = useMemo(() => new Set(archivedSessionIds), [archivedSessionIds])

  const scopedRecords = useMemo(
    () => recordsForWorkspace(sessionRecords, currentWorkspace?.realPath ?? null),
    [sessionRecords, currentWorkspace?.realPath]
  )

  // Sidebar rows are projected from the unified registry, then joined to the
  // live session map for runtime-only fields (busy, queue, approval state).
  // On resume, the history capability is removed and a live record takes over.
  const scopedLiveSessions = useMemo(() => {
    const liveIds = new Set(
      scopedRecords
        .filter((record) => record.isLive && record.runtimeSessionId)
        .map((record) => record.runtimeSessionId as string)
    )
    return sessions.filter((session) => liveIds.has(session.id))
  }, [scopedRecords, sessions])

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return scopedLiveSessions
    return scopedLiveSessions.filter((s) => {
      if (s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)) return true
      const list = searchMessages[s.id]
      const last = list?.[list.length - 1]
      return last ? last.content.toLowerCase().includes(q) : false
    })
  }, [scopedLiveSessions, query, searchMessages])

  // Pinned sessions first, each group keeping its original order
  const pinnedSessions = useMemo(
    () => filteredSessions.filter((s) => pinnedSet.has(s.id) && !archivedSet.has(s.id)),
    [filteredSessions, pinnedSet, archivedSet]
  )
  const normalSessions = useMemo(
    () => filteredSessions.filter((s) => !pinnedSet.has(s.id) && !archivedSet.has(s.id)),
    [filteredSessions, pinnedSet, archivedSet]
  )
  const archivedSessions = useMemo(
    () => filteredSessions.filter((s) => archivedSet.has(s.id)),
    [filteredSessions, archivedSet]
  )

  // ---- group live sessions by their project (session.cwd) --------------
  // Known projects are the ones in recentProjects plus the current project;
  // anything else lands in a bottom "untied to a project" group. All entries
  // are canonical real paths because session.cwd is one too.
  const projectOrder = useMemo(() => {
    const order: string[] = []
    if (currentWorkspace) order.push(currentWorkspace.realPath)
    for (const p of recentProjects) if (!order.includes(p)) order.push(p)
    return order
  }, [currentWorkspace, recentProjects])

  const sessionCwdSet = useMemo(() => {
    const set = new Set<string>()
    for (const s of scopedLiveSessions) if (s.cwd) set.add(s.cwd)
    return set
  }, [scopedLiveSessions])

  const groupedProjectCwds = useMemo(
    () => projectOrder.filter((p) => sessionCwdSet.has(p)),
    [projectOrder, sessionCwdSet]
  )

  const untiedSessions = useMemo(
    () => scopedLiveSessions.filter((s) => !projectOrder.includes(s.cwd) && !archivedSet.has(s.id)),
    [scopedLiveSessions, projectOrder, archivedSet]
  )

  const renderProjectGroup = (cwd: string) => {
    const group = scopedLiveSessions.filter((s) => s.cwd === cwd && !archivedSet.has(s.id))
    const pinned = group.filter((s) => pinnedSet.has(s.id))
    const normal = group.filter((s) => !pinnedSet.has(s.id))
    const name = basename(cwd) || cwd
    return (
      <div key={cwd} className="mt-2">
        <div className="truncate px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-cream-faint/80">
          {name}
        </div>
        <div className="space-y-0.5">{[...pinned, ...normal].map(renderSessionRow)}</div>
      </div>
    )
  }

  const PROJECT_FOLD_LIMIT = 5
  // The active project already has its own row above — never repeat it in
  // the recents list underneath.
  const otherRecentProjects = useMemo(
    () => recentProjects.filter((entry) => entry !== currentWorkspace?.realPath),
    [recentProjects, currentWorkspace?.realPath]
  )
  const visibleProjects = projectsExpanded
    ? otherRecentProjects
    : otherRecentProjects.slice(0, PROJECT_FOLD_LIMIT)

  // History entries whose file belongs to a live session (resumed from it or
  // freshly created into it) are hidden; the search box filters by title too.
  const visibleHistory = useMemo(() => {
    let list = scopedRecords
      .filter((record) => !record.isLive && record.history)
      .map((record) => record.history as HistorySessionDescriptor)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((h) => h.title.toLowerCase().includes(q))
    return list
  }, [scopedRecords, query])

  const navRow = (active: boolean) =>
    `group flex h-8 w-full items-center gap-2.5 rounded-lg border px-2.5 text-[13px] transition-all duration-150 ease-standard ${
      active
        ? 'border-line bg-ink-850 font-medium text-cream shadow-card'
        : 'border-transparent text-cream-dim hover:bg-overlay hover:text-cream'
    }`

  const iconBtn =
    'shrink-0 rounded-md p-1 text-cream-faint opacity-0 transition-all group-hover:opacity-100'

  const renderSessionRow = (session: (typeof sessions)[number]) => {
    const active = currentSessionId === session.id
    const running = Boolean(busy[session.id])
    const unread = !active && Boolean(unreadSessionIds[session.id])
    // A background session waiting on an approval/plugin dialog needs the
    // user — outranks the plain working dot.
    const waiting = (uiRequests[session.id] || []).length > 0
    // The process is gone (spawn failure / crash) — outranks everything.
    const dead = session.status === 'error'
    const status = getSessionStatus({ busy: running, waiting, error: dead, unread })
    const statusLabel = t(`sidebar.status.${status}`)
    const pinned = pinnedSet.has(session.id)
    const archived = archivedSet.has(session.id)
    return (
      <div
        key={session.id}
        onClick={() => {
          setCurrentSessionId(session.id)
          navigate('/')
        }}
        aria-label={`${session.title}, ${statusLabel}`}
        className={`group flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-[6px] transition-all duration-150 ease-standard ${
          active ? 'border-line bg-ink-850 shadow-card' : 'border-transparent hover:bg-overlay'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            dead
              ? 'bg-red-500'
              : waiting
                ? 'animate-pulse bg-red-400'
                : running
                  ? 'animate-pulse bg-amber-400'
                  : unread
                    ? 'bg-accent'
                    : active
                      ? 'bg-cream-faint'
                      : 'bg-line-strong'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-[13px] font-medium leading-5 ${
              dead ? 'text-cream-faint line-through' : 'text-cream'
            }`}
          >
            {session.title}
          </div>
          <div className="truncate text-[11px] leading-4 text-cream-faint">
            {formatRelativeTime(session.createdAt, language)}
          </div>
        </div>
        <span
          className={`w-16 shrink-0 truncate text-right text-[10px] font-medium ${
            status === 'error'
              ? 'text-red-500'
              : status === 'attention'
                ? 'text-red-400'
                : status === 'running'
                  ? 'text-amber-400'
                  : status === 'unread'
                    ? 'text-accent'
                    : 'text-cream-faint/70'
          }`}
        >
          {statusLabel}
        </span>
        {!archived && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              togglePinSession(session.id)
            }}
            title={pinned ? t('sidebar.unpin') : t('sidebar.pin')}
            className={
              pinned
                ? 'shrink-0 rounded-md p-1 text-accent transition-all hover:bg-overlay-strong'
                : `${iconBtn} hover:bg-overlay-strong hover:text-cream-dim`
            }
          >
            {pinned ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
        )}
        {/* The live session can't be archived */}
        {!active && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setSessionArchived(session.id, !archived)
            }}
            title={archived ? t('sidebar.unarchive') : t('sidebar.archive')}
            className={`${iconBtn} hover:bg-overlay-strong hover:text-cream-dim`}
          >
            {archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            // Two-stage confirm: deleting kills the live pi process.
            deleteSessionConfirm.click(session.id)
          }}
          title={
            deleteSessionConfirm.confirmingId === session.id
              ? t('sidebar.deleteConfirm')
              : t('sidebar.deleteSession')
          }
          className={
            deleteSessionConfirm.confirmingId === session.id
              ? 'shrink-0 rounded-md bg-red-500/15 p-1 text-red-500 transition-all'
              : `${iconBtn} hover:bg-red-500/15 hover:text-red-500`
          }
        >
          <Trash2 size={12} />
        </button>
      </div>
    )
  }

  const renderHistoryRow = (info: HistorySessionDescriptor) => {
    const resuming = resumingHistoryId === info.id
    const confirming = deleteHistoryConfirm.confirmingId === info.id
    const failed = restoreFailedHistoryId === info.id
    return (
      <div
        key={info.id}
        onClick={() => void handleResumeHistory(info)}
        title={info.title}
        className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-[6px] transition-colors duration-150 hover:bg-overlay ${
          resuming ? 'pointer-events-none opacity-60' : ''
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-5 text-cream-dim">
            {info.title === 'Untitled' ? t('history.untitled') : info.title}
          </div>
          <div
            className={`truncate text-[11px] leading-4 ${
              failed || deleteFailedHistoryId === info.id
                ? 'text-red-500'
                : 'text-cream-faint/70'
            }`}
          >
            {failed
              ? t('history.restoreFailed')
              : deleteFailedHistoryId === info.id
                ? t('history.deleteFailed')
                : formatRelativeTime(info.timestamp, language)}
          </div>
        </div>
        {resuming ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-cream-faint" />
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation()
              deleteHistoryConfirm.click(info.id)
            }}
            title={confirming ? t('history.deleteConfirm') : t('history.delete')}
            className={
              confirming
                ? 'shrink-0 rounded-md bg-red-500/15 p-1 text-red-500 transition-all'
                : `${iconBtn} hover:bg-red-500/15 hover:text-red-500`
            }
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    )
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-ink-900">
      {/* drag spacer — clears the macOS traffic lights */}
      <div className="app-drag h-11 shrink-0" />

      <div className="app-drag flex items-center justify-between px-3.5 pb-3">
        <div className="flex items-center gap-2.5">
          <Logo size={22} className="shrink-0" />
          <span className="text-[13.5px] font-semibold tracking-tight text-cream">投手</span>
        </div>
      </div>

      <nav className="space-y-0.5 px-2.5">
        {/* 对话 = 回首页 + 清空选中。会话只在第一条消息发出时创建（⌘N 同效）。 */}
        <button
          onClick={() => {
            setCurrentSessionId(null)
            navigate('/')
          }}
          className={navRow(location.pathname === '/' && !currentSessionId)}
        >
          <MessageSquare size={14} className="shrink-0" />
          {t('sidebar.chat')}
          <span className="kbd ml-auto opacity-0 transition-opacity group-hover:opacity-100">⌘N</span>
        </button>
        <button
          onClick={() => navigate('/plugins')}
          className={navRow(location.pathname === '/plugins')}
        >
          <Puzzle size={14} className="shrink-0" />
          {t('sidebar.plugins')}
        </button>
        <button
          onClick={() => navigate('/boards')}
          className={navRow(location.pathname === '/boards')}
        >
          <SquareKanban size={14} className="shrink-0" />
          {t('sidebar.boards')}
        </button>
        <button
          onClick={() => navigate('/skills')}
          className={navRow(location.pathname === '/skills')}
        >
          <Library size={14} className="shrink-0" />
          {t('sidebar.skills')}
        </button>
      </nav>

      {cliAvailable === false && (
        <div className="mx-2.5 mt-2.5 flex items-start gap-2 rounded-lg border border-yellow-500/25 bg-yellow-500/10 p-2.5 text-xs leading-5 text-yellow-700 dark:text-yellow-200/90">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <div>
            <span>{t('sidebar.cliMissing')}</span>
            <button
              onClick={() => setSetupComplete(false)}
              className="mt-1 block font-medium underline underline-offset-2 transition-colors hover:text-yellow-900 dark:hover:text-yellow-100"
            >
              {t('sidebar.cliInstall')}
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 px-2.5">
        <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
          {t('sidebar.project')}
        </div>
        {currentWorkspace ? (
          <div className={`${navRow(true)} cursor-default font-mono text-xs`}>
            <FolderOpen size={13} className="shrink-0 text-cream-faint" />
            <span className="min-w-0 flex-1 truncate" title={currentWorkspace.displayPath}>
              {currentWorkspace.source === 'default'
                ? t('sidebar.defaultWorkspace')
                : currentWorkspace.displayPath}
            </span>
            <button
              onClick={handleSelectProject}
              title={t('sidebar.selectProject')}
              className="shrink-0 rounded-md p-1 text-cream-faint transition-colors hover:bg-overlay hover:text-cream"
            >
              <FolderOpen size={12} />
            </button>
          </div>
        ) : (
          <button onClick={handleSelectProject} className={`${navRow(false)} font-mono text-xs`}>
            <FolderOpen size={13} className="shrink-0 text-cream-faint" />
            <span className="truncate">{t('sidebar.selectProject')}</span>
          </button>
        )}
        {otherRecentProjects.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {visibleProjects.map((path) => {
              const name = basename(path) || path
              return (
                <div
                  key={path}
                  onClick={() => handleSwitchProject(path)}
                  title={path}
                  className={`${navRow(path === currentWorkspace?.realPath)} cursor-pointer`}
                >
                  <FolderOpen size={13} className="shrink-0 text-cream-faint" />
                  <span className="truncate">{name}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeRecentProject(path)
                    }}
                    title={t('sidebar.removeRecent')}
                    className={`${iconBtn} ml-auto hover:bg-overlay-strong hover:text-cream-dim`}
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}
            {otherRecentProjects.length > PROJECT_FOLD_LIMIT && (
              <button
                onClick={() => setProjectsExpanded(!projectsExpanded)}
                className="flex w-full items-center gap-1 px-2 pb-1 pt-1.5 text-[11px] text-cream-faint transition-colors hover:text-cream-dim"
              >
                {projectsExpanded ? (
                  <ChevronDown size={11} strokeWidth={1.5} />
                ) : (
                  <ChevronRight size={11} strokeWidth={1.5} />
                )}
                {projectsExpanded
                  ? t('sidebar.showLess')
                  : t('sidebar.showMore', { count: otherRecentProjects.length - PROJECT_FOLD_LIMIT })}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mt-5 flex-1 overflow-y-auto px-2.5 pb-4">
        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
            {t('sidebar.sessions')}
          </span>
          <button
            onClick={() => {
              setSearchOpen(!searchOpen)
              if (searchOpen) setQuery('')
            }}
            title={t('sidebar.searchSessions')}
            className="rounded-md p-1 text-cream-faint transition-colors hover:bg-overlay hover:text-cream"
          >
            {searchOpen ? <X size={12} /> : <Search size={12} />}
          </button>
        </div>
        {searchOpen && (
          <div className="px-2 pb-2">
            <div className="relative">
              <Search
                size={12}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cream-faint"
              />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchOpen(false)
                    setQuery('')
                  }
                }}
                placeholder={t('sidebar.searchSessions')}
                className="h-7 w-full rounded-full border border-line bg-ink-850 pl-7 pr-2.5 text-[12px] text-cream placeholder-cream-faint outline-none transition-colors focus:border-accent/50"
              />
            </div>
          </div>
        )}
        {searching ? (
          // Search: flat filtered list (grouping is only for the default view).
          filteredSessions.length === 0 ? (
            <div className="px-2 py-1.5 text-xs leading-5 text-cream-faint">{t('sidebar.noMatch')}</div>
          ) : (
            <div className="space-y-0.5">{[...pinnedSessions, ...normalSessions].map(renderSessionRow)}</div>
          )
        ) : scopedLiveSessions.length === 0 ? (
          <div className="px-2 py-1.5 text-xs leading-5 text-cream-faint">{t('sidebar.noSessions')}</div>
        ) : (
          <>
            {groupedProjectCwds.map(renderProjectGroup)}
            {untiedSessions.length > 0 && (
              <div className="mt-2">
                <div className="truncate px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-cream-faint/80">
                  {t('chat.noProject')}
                </div>
                <div className="space-y-0.5">
                  {[...untiedSessions.filter((s) => pinnedSet.has(s.id)), ...untiedSessions.filter((s) => !pinnedSet.has(s.id))].map(renderSessionRow)}
                </div>
              </div>
            )}
          </>
        )}

        {archivedSessions.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setArchiveOpen(!archiveOpen)}
              className="flex w-full items-center gap-1 px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint transition-colors hover:text-cream-dim"
            >
              {archiveOpen ? (
                <ChevronDown size={11} strokeWidth={1.5} />
              ) : (
                <ChevronRight size={11} strokeWidth={1.5} />
              )}
              {t('sidebar.archived', { count: archivedSessions.length })}
            </button>
            {archiveOpen && <div className="space-y-0.5">{archivedSessions.map(renderSessionRow)}</div>}
          </div>
        )}

        {visibleHistory.length > 0 && (
          <div className="mt-4">
            <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
              {t('history.title')}
            </div>
            <div className="space-y-0.5">{visibleHistory.map(renderHistoryRow)}</div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-line px-2.5 py-2">
        <button
          onClick={() => navigate('/settings')}
          title={t('sidebar.settings')}
          className={`focus-ring rounded-md p-1.5 transition-colors ${
            location.pathname === '/settings'
              ? 'bg-overlay-strong text-cream'
              : 'text-cream-faint hover:bg-overlay hover:text-cream'
          }`}
        >
          <Settings size={15} />
        </button>
        <div className="ml-0.5 flex rounded-full border border-line bg-ink-800 p-0.5">
          {(['zh', 'en'] as const).map((lang) => (
            <button
              key={lang}
              onClick={() => setLanguage(lang)}
              className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
                language === lang
                  ? 'border-line bg-ink-850 text-cream shadow-card'
                  : 'border-transparent text-cream-dim hover:text-cream'
              }`}
            >
              {lang === 'zh' ? t('settings.languageZh') : t('settings.languageEn')}
            </button>
          ))}
        </div>
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={t('sidebar.theme')}
          className="focus-ring ml-auto rounded-md p-1.5 text-cream-faint transition-colors hover:bg-overlay hover:text-cream"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-line bg-ink-850 px-3.5 py-1.5 text-xs text-cream shadow-pop"
        >
          {t(notice.key)}
        </div>
      )}
    </aside>
  )
}
