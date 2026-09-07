import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Link2, Clock} from 'lucide-react'
import { HistorySessionDescriptor, HistorySessionRow, SessionSortOrder } from '@shared/types'
import { MessageLike, useAppStore } from '../store'
import { useT } from '../i18n'
import { useNotice, showNotice } from '../lib/notice'
import {
  recordDurableUuid,
  recordsForWorkspace,
  sessionFileUuid,
  sortSessionRows
} from '../lib/sessionRegistry'
import { formatRelativeTime } from '../lib/time'
import { getSessionStatus } from '../lib/sessionStatus'
import { basename } from '../lib/path'
import { useConfirmId } from '../lib/confirmClick'
import Logo from './Logo'
import MenuPortal from './MenuPortal'

const EMPTY_MESSAGES: Record<string, MessageLike[]> = {}

// Sidebar drag-resize bounds (px). The min keeps the widest row (a live
// session with its three action buttons) from overflowing; the max leaves the
// chat pane readable. Matches mature desktop agent apps.
const SIDEBAR_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 420
const SIDEBAR_DEFAULT_WIDTH = 240

const clampSidebarWidth = (width: number): number => {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  // Never starve the main pane below the sidebar's own minimum; the floor
  // keeps tiny windows clamped to the min instead of an impossible range.
  const windowBound = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - SIDEBAR_MIN_WIDTH)
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, windowBound, Math.max(SIDEBAR_MIN_WIDTH, width)))
}

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
  const globalHistory = useAppStore((s) => s.globalHistory)
  const loadAllHistorySessions = useAppStore((s) => s.loadAllHistorySessions)
  const scheduledTasks = useAppStore((s) => s.scheduledTasks)
  const setScheduledTasks = useAppStore((s) => s.setScheduledTasks)
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
  const purgeDeletedSession = useAppStore((s) => s.purgeDeletedSession)
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
  const [deleteFailedGlobalUuid, setDeleteFailedGlobalUuid] = useState<string | null>(null)

  // Sidebar width. Persisted through Main's typed settings store, like every
  // other UI pref (theme, language, pinned ids). A drag writes the width
  // straight onto the <aside> via ref — no React render per pointermove — and
  // the state below only commits on release so renders stay consistent.
  const asideRef = useRef<HTMLElement>(null)
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH)
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [sidebarResizing, setSidebarResizing] = useState(false)

  // Restore the persisted width on mount, clamped against the live window.
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getStore('sidebarWidth').then((width) => {
      if (cancelled || sidebarDragRef.current) return
      const next = clampSidebarWidth(width)
      sidebarWidthRef.current = next
      setSidebarWidth(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Session list ordering. Persisted through Main's typed settings store like
  // the sidebar width; hydrated once on mount (store default is 'recent').
  const [sessionSort, setSessionSort] = useState<SessionSortOrder>('recent')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const sortButtonRef = useRef<HTMLButtonElement>(null)
  // Showing the archived section is a transient view toggle, not a setting.
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getStore('sessionSort').then((sort) => {
      if (cancelled) return
      if (sort === 'recent' || sort === 'name') setSessionSort(sort)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const commitSessionSort = (sort: SessionSortOrder) => {
    setSessionSort(sort)
    void window.electronAPI.setStore('sessionSort', sort)
  }

  const commitSidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width)
    sidebarWidthRef.current = next
    setSidebarWidth(next)
    void window.electronAPI.setStore('sidebarWidth', next)
  }

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || sidebarDragRef.current) return
    e.preventDefault()
    sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidthRef.current }
    // Capture so the drag keeps tracking when the pointer leaves the handle.
    e.currentTarget.setPointerCapture(e.pointerId)
    setSidebarResizing(true)
    document.body.classList.add('sidebar-resizing')
  }

  const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = sidebarDragRef.current
    if (!drag || !asideRef.current) return
    const next = clampSidebarWidth(drag.startWidth + (e.clientX - drag.startX))
    if (next === sidebarWidthRef.current) return
    sidebarWidthRef.current = next
    asideRef.current.style.width = `${next}px`
  }

  const handleResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarDragRef.current) return
    sidebarDragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setSidebarResizing(false)
    document.body.classList.remove('sidebar-resizing')
    commitSidebarWidth(sidebarWidthRef.current)
  }

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

  // Cross-project durable history: refresh on mount, on workspace change, and
  // whenever this window regains focus (another window may have added sessions).
  useEffect(() => {
    void loadAllHistorySessions()
    const onFocus = () => void loadAllHistorySessions()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [currentWorkspace, loadAllHistorySessions])

  // Scheduled task state changes come from Main via push.
  useEffect(() => {
    return window.electronAPI.onTasksStateChanged(setScheduledTasks)
  }, [setScheduledTasks])

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

  // Runtime id → registry record. The record is the renderer's only link
  // between a live session and its durable transcript identity.
  const recordByRuntimeId = useMemo(
    () =>
      new Map(
        sessionRecords
          .filter((record) => record.runtimeSessionId)
          .map((record) => [record.runtimeSessionId as string, record])
      ),
    [sessionRecords]
  )

  /**
   * Delete every durable copy of one uuid and, on success, purge it from every
   * in-memory cache so a rescan cannot resurface the deleted row. Refreshes
   * the durable scans only after the delete settles (an earlier rescan could
   * still see the file and re-add the row behind the purge).
   */
  const deleteByUuidAndRefresh = async (uuid: string | null): Promise<boolean> => {
    if (!uuid || !currentWorkspace) return false
    const ok = await window.electronAPI.deleteSessionByUuid(currentWorkspace.id, uuid)
    if (ok) purgeDeletedSession(uuid)
    void loadHistorySessions(currentWorkspace.id)
    void loadAllHistorySessions()
    return ok
  }

  const handleDeleteSession = (id: string) => {
    // The durable identity must be captured before the kill: the record is the
    // renderer's only link between the runtime id and the transcript file.
    const record = recordByRuntimeId.get(id)
    const uuid = recordDurableUuid(record)
    window.electronAPI.killSession(id)
    setSessions(sessions.filter((s) => s.id !== id))
    if (currentSessionId === id) {
      setCurrentSessionId(null)
    }
    // A killed session's transcript stays on disk and would resurface in the
    // durable scan (immediately as a history row, after restart via the
    // cross-project list) — delete every copy of it too.
    void deleteByUuidAndRefresh(uuid)
  }

  /**
   * Archive/unarchive by the session's durable key (uuid when the registry
   * knows one, else the runtime id). Archiving a LIVE session takes the
   * delete path's kill WITHOUT the uuid sweep: the process dies and the live
   * row goes, but the transcript stays on disk and resurfaces — already
   * archived under its uuid — once the history scans refresh.
   */
  const handleArchiveSession = (id: string, archived: boolean) => {
    if (!archived) {
      // Unarchive clears every key form the entry could have been written
      // under: the durable uuid and a runtime-id fallback from before the
      // uuid was known. Otherwise the row could never leave the archive.
      setSessionArchived(id, false)
      const uuid = durableUuidOfSession(id)
      if (uuid !== null) setSessionArchived(uuid, false)
      return
    }
    setSessionArchived(durableUuidOfSession(id) ?? id, true)
    if (!sessions.some((s) => s.id === id)) return
    window.electronAPI.killSession(id)
    setSessions(sessions.filter((s) => s.id !== id))
    if (currentSessionId === id) {
      setCurrentSessionId(null)
    }
    // Rescan so the durable row reappears immediately (hidden by its key).
    void loadHistorySessions(currentWorkspace?.id ?? null)
    void loadAllHistorySessions()
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
    // Capability delete first (tightest binding). It can legitimately fail for
    // a stale or expired capability — e.g. a row that failed to restore — so
    // fall back to the uuid sweep, which is copy-proof and works regardless of
    // which workspace is active. Only a Main-verified "file still present"
    // keeps the row and surfaces the failure state.
    let ok = await window.electronAPI.deleteSessionFile(currentWorkspace.id, info.id)
    if (!ok) ok = await window.electronAPI.deleteSessionByUuid(currentWorkspace.id, info.uuid)
    // Only the history entry goes away on success — a failed delete keeps the
    // item and surfaces a user-visible error (never silent success).
    if (ok) {
      setDeleteFailedHistoryId(null)
      // Purge the durable uuid from every cache (records of every workspace +
      // the cross-project list), then rescan — an earlier rescan could still
      // have seen the file.
      purgeDeletedSession(info.uuid)
      void loadHistorySessions(currentWorkspace.id)
      void loadAllHistorySessions()
    } else {
      setDeleteFailedHistoryId(info.id)
      setTimeout(() => setDeleteFailedHistoryId((id) => (id === info.id ? null : id)), 3000)
    }
  }

  /** Cross-project durable row delete: resolved Main-side by uuid. */
  const handleDeleteGlobal = async (row: HistorySessionRow) => {
    if (!currentWorkspace) return
    const ok = await deleteByUuidAndRefresh(row.uuid)
    if (ok) {
      setDeleteFailedGlobalUuid(null)
    } else {
      setDeleteFailedGlobalUuid(row.uuid)
      setTimeout(() => setDeleteFailedGlobalUuid((uuid) => (uuid === row.uuid ? null : uuid)), 3000)
    }
  }

  /**
   * Open a cross-project durable history row. Rows of the CURRENT workspace
   * mint capabilities in place; other rows switch to their project first when
   * that project is in the recents list (the only trusted authority source),
   * then resume. Everything else asks the user to add the folder first.
   */
  const handleOpenGlobal = async (row: (typeof globalHistory)[number]) => {
    if (resumingHistoryId || historyLoading) return
    const state = useAppStore.getState()
    const resumeByUuid = async (): Promise<boolean> => {
      await loadHistorySessions(state.currentWorkspace?.id ?? null)
      const match = useAppStore
        .getState()
        .sessionRecords.find((r) => !r.isLive && r.history?.uuid === row.uuid)
      if (!match?.history) return false
      await handleResumeHistory(match.history)
      return true
    }

    if (state.currentWorkspace && row.cwd === state.currentWorkspace.realPath) {
      if (await resumeByUuid()) return
      showNotice('history.restoreFailed')
      return
    }

    const target = state.recentWorkspaces.find(
      (workspace) => basename(workspace.displayPath) === basename(row.cwd)
    )
    if (!target) {
      showNotice('sidebar.projectNotAdded')
      return
    }
    await activateRecentWorkspace(target.id)
    const activated = useAppStore.getState().currentWorkspace
    if (!activated || activated.realPath !== row.cwd) {
      showNotice('sidebar.projectNotAdded')
      return
    }
    if (await resumeByUuid()) return
    showNotice('sidebar.projectSwitched')
  }

  const deleteHistoryConfirm = useConfirmId((id: string) => {
    setDeleteFailedHistoryId(null)
    const info = visibleHistory.find((entry) => entry.id === id)
    if (info) void handleDeleteHistory(info)
  })
  const deleteGlobalConfirm = useConfirmId((uuid: string) => {
    setDeleteFailedGlobalUuid(null)
    const row = globalHistory.find((entry) => entry.uuid === uuid)
    if (row) void handleDeleteGlobal(row)
  })
  const deleteSessionConfirm = useConfirmId((id: string) => handleDeleteSession(id))

  const pinnedSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds])
  const archivedSet = useMemo(() => new Set(archivedSessionIds), [archivedSessionIds])

  // Archive key of a live session: its durable uuid when the registry knows
  // one, else the runtime id. UUID keys survive the live→durable handoff.
  const durableUuidOfSession = useCallback(
    (id: string) => recordDurableUuid(recordByRuntimeId.get(id)),
    [recordByRuntimeId]
  )
  const isSessionArchived = useCallback(
    (id: string) => {
      const uuid = durableUuidOfSession(id)
      return archivedSet.has(id) || (uuid !== null && archivedSet.has(uuid))
    },
    [archivedSet, durableUuidOfSession]
  )

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

  // Search matches live sessions on title/path and the tail of the streaming
  // transcript. Archived live sessions live in the archive section only, so
  // they never match here.
  const filteredSessions = useMemo(() => {
    const base = scopedLiveSessions.filter((s) => !isSessionArchived(s.id))
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter((s) => {
      if (s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)) return true
      const list = searchMessages[s.id]
      const last = list?.[list.length - 1]
      return last ? last.content.toLowerCase().includes(q) : false
    })
  }, [scopedLiveSessions, query, searchMessages, isSessionArchived])

  // Search view: pinned sessions float first, each group in the chosen order.
  const sortedSearchSessions = useMemo(() => {
    const decorate = (session: (typeof sessions)[number]) => ({
      session,
      title: session.title,
      timestamp: session.createdAt,
      pinned: pinnedSet.has(session.id)
    })
    return {
      pinned: sortSessionRows(
        filteredSessions.filter((s) => pinnedSet.has(s.id)).map(decorate),
        sessionSort
      ).map((item) => item.session),
      normal: sortSessionRows(
        filteredSessions.filter((s) => !pinnedSet.has(s.id)).map(decorate),
        sessionSort
      ).map((item) => item.session)
    }
  }, [filteredSessions, pinnedSet, sessionSort])

  // ---- group live sessions by their project (session.cwd) --------------
  // (Removed in the flat-recents model: the sidebar lists live + durable
  // sessions across projects in one recency-ordered "最近" list; each row
  // carries its project as a suffix. Project grouping remains in the
  // dedicated 项目 section above.)

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

  // ---- unified "最近" flat list ------------------------------------------
  // Live sessions (every project), workspace-bound history rows, and the
  // cross-project durable scan merge into one list. The durable scan is what
  // makes the sidebar survive restarts.
  type RecentEntry =
    | { kind: 'live'; key: string; timestamp: number; title: string; pinned: boolean; projectName: string; session: (typeof sessions)[number] }
    | { kind: 'history'; key: string; timestamp: number; title: string; pinned: false; projectName: string; info: HistorySessionDescriptor }
    | { kind: 'global'; key: string; timestamp: number; title: string; pinned: false; projectName: string; row: (typeof globalHistory)[number] }

  const liveUuids = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) {
      const record = recordByRuntimeId.get(s.id)
      if (record?.history?.uuid) set.add(record.history.uuid)
      const fileUuid = sessionFileUuid(record?.sessionFile)
      if (fileUuid) set.add(fileUuid)
    }
    return set
  }, [recordByRuntimeId, sessions])

  // Every row candidate, deduped. Archived entries are partitioned out of it
  // right afterwards; both lists then take the user's sort.
  const allEntries = useMemo(() => {
    const entries: RecentEntry[] = []
    for (const s of sessions) {
      entries.push({
        kind: 'live',
        key: `live:${s.id}`,
        timestamp: s.createdAt,
        title: s.title,
        pinned: pinnedSet.has(s.id),
        projectName: basename(s.cwd) || s.cwd,
        session: s
      })
    }
    const historyUuids = new Set(visibleHistory.map((h) => h.uuid))
    for (const info of visibleHistory) {
      if (liveUuids.has(info.uuid)) continue
      entries.push({
        kind: 'history',
        key: `history:${info.id}`,
        timestamp: info.timestamp,
        title: info.title,
        pinned: false,
        projectName: basename(currentWorkspace?.realPath ?? '') || '',
        info
      })
    }
    for (const row of globalHistory) {
      if (liveUuids.has(row.uuid) || historyUuids.has(row.uuid)) continue
      entries.push({
        kind: 'global',
        key: `global:${row.uuid}`,
        timestamp: row.timestamp,
        title: row.title,
        pinned: false,
        projectName: basename(row.cwd) || row.cwd,
        row
      })
    }
    // The twin dedupe below needs a deterministic base order; recency is it.
    // The user-facing sort is applied to the partitioned lists.
    entries.sort((a, b) => b.timestamp - a.timestamp)
    // Resuming a session forks a NEW file with a NEW uuid but the same first
    // user message, so uuid-only dedupe leaves near-identical twins (same
    // project, same title, timestamps seconds apart). Prefer the row that can
    // be opened in place: live > capability-backed history > global.
    const rank = (entry: RecentEntry) => (entry.kind === 'live' ? 0 : entry.kind === 'history' ? 1 : 2)
    const deduped: RecentEntry[] = []
    for (const entry of entries) {
      const twin = deduped.find(
        (candidate) =>
          candidate.projectName === entry.projectName &&
          candidate.title === entry.title &&
          Math.abs(candidate.timestamp - entry.timestamp) < 60_000
      )
      if (!twin) {
        deduped.push(entry)
        continue
      }
      if (rank(entry) < rank(twin)) deduped[deduped.indexOf(twin)] = entry
    }
    return deduped
  }, [sessions, visibleHistory, globalHistory, liveUuids, pinnedSet, currentWorkspace])

  // Archived test per entry kind. Live rows consult their durable uuid too, so
  // a killed-and-resurfaced session stays archived across the handoff.
  const isEntryArchived = useCallback(
    (entry: RecentEntry) => {
      if (entry.kind === 'live') return isSessionArchived(entry.session.id)
      return archivedSet.has(entry.kind === 'history' ? entry.info.uuid : entry.row.uuid)
    },
    [archivedSet, isSessionArchived]
  )

  // Pinned rows float first under both orders (see sortSessionRows).
  const recentEntries = useMemo(
    () => sortSessionRows(allEntries.filter((entry) => !isEntryArchived(entry)), sessionSort),
    [allEntries, isEntryArchived, sessionSort]
  )
  const archivedEntries = useMemo(
    () => sortSessionRows(allEntries.filter(isEntryArchived), sessionSort),
    [allEntries, isEntryArchived, sessionSort]
  )

  const filteredRecentEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return recentEntries
    return recentEntries.filter((entry) => {
      if (entry.title.toLowerCase().includes(q)) return true
      if (entry.kind !== 'live') return false
      const list = searchMessages[entry.session.id]
      const last = list?.[list.length - 1]
      return last ? last.content.toLowerCase().includes(q) : false
    })
  }, [recentEntries, query, searchMessages])

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
    // Externally created (Feishu channel) rows keep a brand badge so users can
    // tell where the conversation lives; foreign-workspace rows carry the
    // project suffix like the cross-project history rows do.
    const feishu = session.origin === 'feishu'
    const foreignWorkspace = session.cwd !== currentWorkspace?.realPath
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
            className={`flex min-w-0 items-center gap-1.5 ${
              dead ? 'text-cream-faint line-through' : 'text-cream'
            }`}
          >
            <span className="min-w-0 truncate text-[13px] font-medium leading-5">{session.title}</span>
            {feishu && (
              <span
                className="shrink-0 rounded border border-line px-1 text-[9px] font-medium leading-[14px] text-cream-faint"
                title={t('sidebar.feishuSession')}
              >
                飞书
              </span>
            )}
          </div>
          <div className="truncate text-[11px] leading-4 text-cream-faint">
            {foreignWorkspace
              ? `${basename(session.cwd) || session.cwd} · ${formatRelativeTime(session.createdAt, language)}`
              : formatRelativeTime(session.createdAt, language)}
          </div>
        </div>
        {/* min-w-0 + shrink: at the sidebar's min width the fixed action
            buttons win and the status label truncates instead of overflowing */}
        <span
          className={`w-16 min-w-0 shrink truncate text-right text-[10px] font-medium ${
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
        <button
          onClick={(e) => {
            e.stopPropagation()
            // Kills a live session (its durable file stays) and hides the
            // durable row behind the archive key.
            handleArchiveSession(session.id, true)
          }}
          title={t('sidebar.archive')}
          className={`${iconBtn} hover:bg-overlay-strong hover:text-cream-dim`}
        >
          <Archive size={12} />
        </button>
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

  /**
   * Archived rows are read-only summaries: title + project suffix, unarchive
   * and delete. Opening one auto-unarchives it — an open session is not
   * archived — so history/global rows resume as usual with their key cleared
   * first and the resumed live row stays visible.
   */
  const renderArchivedRow = (entry: RecentEntry) => {
    const unarchiveAndOpen = () => {
      if (entry.kind === 'live') {
        handleArchiveSession(entry.session.id, false)
        setCurrentSessionId(entry.session.id)
        navigate('/')
        return
      }
      setSessionArchived(entry.kind === 'history' ? entry.info.uuid : entry.row.uuid, false)
      if (entry.kind === 'history') void handleResumeHistory(entry.info)
      else void handleOpenGlobal(entry.row)
    }
    const confirmDelete = () => {
      if (entry.kind === 'live') deleteSessionConfirm.click(entry.session.id)
      else if (entry.kind === 'history') deleteHistoryConfirm.click(entry.info.id)
      else deleteGlobalConfirm.click(entry.row.uuid)
    }
    return (
      <div
        key={entry.key}
        onClick={unarchiveAndOpen}
        title={entry.title}
        className="group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-[6px] transition-colors duration-150 hover:bg-overlay"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-5 text-cream-faint">
            {entry.title === 'Untitled' ? t('history.untitled') : entry.title}
          </div>
          <div className="truncate text-[11px] leading-4 text-cream-faint/70">
            {`${entry.projectName} · ${formatRelativeTime(entry.timestamp, language)}`}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            unarchiveAndOpen()
          }}
          title={t('sidebar.unarchive')}
          className={`${iconBtn} hover:bg-overlay-strong hover:text-cream-dim`}
        >
          <ArchiveRestore size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            confirmDelete()
          }}
          title={t('history.delete')}
          className={`${iconBtn} hover:bg-red-500/15 hover:text-red-500`}
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

  /**
   * Cross-project durable row: opens via workspace switch + resume. Its delete
   * is resolved Main-side by uuid, so it works no matter which workspace is
   * active — including rows whose restore failed and never minted a capability.
   */
  const renderGlobalRow = (row: (typeof globalHistory)[number]) => {
    const resuming = resumingHistoryId !== null
    const confirming = deleteGlobalConfirm.confirmingId === row.uuid
    return (
      <div
        key={`global:${row.uuid}`}
        onClick={() => void handleOpenGlobal(row)}
        title={row.cwd}
        className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-[6px] transition-colors duration-150 hover:bg-overlay ${
          resuming ? 'pointer-events-none opacity-60' : ''
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-5 text-cream-dim">
            {row.title === 'Untitled' ? t('history.untitled') : row.title}
          </div>
          <div
            className={`truncate text-[11px] leading-4 ${
              deleteFailedGlobalUuid === row.uuid ? 'text-red-500' : 'text-cream-faint/70'
            }`}
          >
            {deleteFailedGlobalUuid === row.uuid
              ? t('history.deleteFailed')
              : `${basename(row.cwd) || row.cwd} · ${formatRelativeTime(row.timestamp, language)}`}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            deleteGlobalConfirm.click(row.uuid)
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
      </div>
    )
  }

  // Archived live sessions don't count toward the running banner — they are
  // killed on archive, so a remaining busy entry is a fallback-path leftover.
  const runningCount = useMemo(
    () => sessions.reduce((count, s) => count + (busy[s.id] && !isSessionArchived(s.id) ? 1 : 0), 0),
    [sessions, busy, isSessionArchived]
  )

  const renderRecentEntry = (entry: RecentEntry) => {
    if (entry.kind === 'live') return renderSessionRow(entry.session)
    if (entry.kind === 'history') return renderHistoryRow(entry.info)
    return renderGlobalRow(entry.row)
  }

  return (
    <aside
      ref={asideRef}
      style={{ width: sidebarWidth }}
      className="relative flex shrink-0 flex-col border-r border-line bg-ink-900"
    >
      {/* drag spacer — clears the macOS traffic lights */}
      <div className="app-drag h-11 shrink-0" />

      {/* Resize handle: spans everything below the drag spacer so it never
          fights window dragging, overlays the border, highlights on hover,
          and resets to the default on double-click. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        onDoubleClick={() => commitSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        className={`app-no-drag absolute bottom-0 right-0 top-11 z-20 w-[5px] touch-none cursor-col-resize transition-colors duration-150 ${
          sidebarResizing ? 'bg-accent/50' : 'hover:bg-accent/25'
        }`}
      />

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
        <button
          onClick={() => navigate('/connections')}
          className={navRow(location.pathname === '/connections')}
        >
          <Link2 size={14} className="shrink-0" />
          {t('sidebar.connections')}
        </button>
        <button
          onClick={() => navigate('/tasks')}
          className={navRow(location.pathname === '/tasks')}
        >
          <Clock size={14} className="shrink-0" />
          {t('sidebar.tasks')}
          {scheduledTasks.filter(t => t.enabled).length > 0 && (
            <span className="ml-auto rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              {scheduledTasks.filter(t => t.enabled).length}
            </span>
          )}
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

      {/* Running task count */}
      {runningCount > 0 && (
        <div className="mx-2.5 mt-2 flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          {t('sidebar.runningCount', { count: runningCount })}
        </div>
      )}

      <div className="mt-5 flex-1 overflow-y-auto px-2.5 pb-4">
        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
            {t('sidebar.sessions')}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              ref={sortButtonRef}
              onClick={() => setSortMenuOpen((open) => !open)}
              title={t('sidebar.sort')}
              className={`rounded-md p-1 transition-colors hover:bg-overlay hover:text-cream ${
                sortMenuOpen ? 'bg-overlay text-cream' : 'text-cream-faint'
              }`}
            >
              <ArrowUpDown size={12} />
            </button>
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
        </div>
        <MenuPortal
          open={sortMenuOpen}
          triggerRef={sortButtonRef}
          onClose={() => setSortMenuOpen(false)}
          width={196}
        >
          {(['recent', 'name'] as const).map((sort) => (
            <button
              key={sort}
              onClick={() => {
                commitSessionSort(sort)
                setSortMenuOpen(false)
              }}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
            >
              <span>{sort === 'recent' ? t('sidebar.sortRecent') : t('sidebar.sortName')}</span>
              {sessionSort === sort && <Check size={12} className="text-accent" />}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            role="switch"
            aria-checked={showArchived}
            onClick={() => setShowArchived((value) => !value)}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
          >
            <span>{t('sidebar.showArchived')}</span>
            <span
              className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors ${
                showArchived ? 'bg-accent' : 'bg-line-strong'
              }`}
            >
              <span
                className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-cream transition-all ${
                  showArchived ? 'left-[12px]' : 'left-0.5'
                }`}
              />
            </span>
          </button>
        </MenuPortal>
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
          filteredSessions.length === 0 ? (
            <div className="px-2 py-1.5 text-xs leading-5 text-cream-faint">{t('sidebar.noMatch')}</div>
          ) : (
            <div className="space-y-0.5">
              {[...sortedSearchSessions.pinned, ...sortedSearchSessions.normal].map(renderSessionRow)}
            </div>
          )
        ) : filteredRecentEntries.length === 0 ? (
          <div className="px-2 py-1.5 text-xs leading-5 text-cream-faint">{t('sidebar.noSessions')}</div>
        ) : (
          <div className="space-y-0.5">{filteredRecentEntries.map(renderRecentEntry)}</div>
        )}

        {!searching && showArchived && archivedEntries.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setArchiveOpen(!archiveOpen)}
              title={t('sidebar.showArchived')}
              className="flex w-full items-center gap-1 px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint transition-colors hover:text-cream-dim"
            >
              {archiveOpen ? (
                <ChevronDown size={11} strokeWidth={1.5} />
              ) : (
                <ChevronRight size={11} strokeWidth={1.5} />
              )}
              {t('sidebar.archived', { count: archivedEntries.length })}
            </button>
            {archiveOpen && (
              <div className="space-y-0.5">{archivedEntries.map(renderArchivedRow)}</div>
            )}
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
