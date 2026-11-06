import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  MessageSquare,
  Puzzle,
  SquareKanban,
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
  Pencil,
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Link2,
  Clock,
  BriefcaseBusiness,
  MoreHorizontal
} from 'lucide-react'
import { HistorySessionDescriptor, HistorySessionRow, SessionSortOrder } from '@shared/types'
import { MessageLike, useAppStore } from '../store'
import { useT, modShortcut } from '../i18n'
import { useNotice, showNotice } from '../lib/notice'
import { cleanSessionName } from '@shared/promptTitle'
import { useModalBoundary } from '../lib/modalBoundary'
import { finishHistoryResume, historyResumeGrant, openGlobalHistory } from '../lib/historyResume'
import { ConfirmDialog } from './ConfirmDialog'
import { runThemeTransition } from '../lib/themeTransition'
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
import SidebarProjects from './SidebarProjects'
import { useProjects } from '../store/projects'
import { sidebarConversations, type SidebarConversation } from '../lib/sidebarConversations'
import { beginNavigationIntent, isCurrentNavigationIntent } from '../lib/navigationIntent'

const EMPTY_MESSAGES: Record<string, MessageLike[]> = {}

// Sidebar drag-resize bounds (px). The min keeps the widest row (a live
// session with its three action buttons) from overflowing; the max leaves the
// chat pane readable. Matches mature desktop agent apps.
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 360
const SIDEBAR_DEFAULT_WIDTH = 260

const clampSidebarWidth = (width: number): number => {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  // Never starve the main pane below the sidebar's own minimum; the floor
  // keeps tiny windows clamped to the min instead of an impossible range.
  const windowBound = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - SIDEBAR_MIN_WIDTH)
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, windowBound, Math.max(SIDEBAR_MIN_WIDTH, width)))
}

/** Registered projects must not fall back to the older path-only recent list. */
export async function activateSidebarProject(cwd: string, intent: number): Promise<'registered' | 'legacy' | 'unavailable'> {
  if (!useProjects.getState().loaded) await useProjects.getState().refresh()
  if (!useProjects.getState().loaded || !isCurrentNavigationIntent(intent)) return 'unavailable'
  const project = useProjects.getState().projects.find(item => item.path === cwd)
  if (!project) return 'legacy'
  const current = useAppStore.getState().currentWorkspace
  if (current?.realPath === cwd && !project.missing && !project.archived) return 'registered'
  if (!(await useProjects.getState().activate(project.id, intent))) return 'unavailable'
  return isCurrentNavigationIntent(intent) && useAppStore.getState().currentWorkspace?.realPath === cwd ? 'registered' : 'unavailable'
}

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const t = useT()
  /**
   * omp spawns untitled sessions with the project-dir name as an internal
   * default. The list must never show that raw name — a fresh chat displays
   * the localized placeholder until first-turn auto-naming gives it a real
   * title (same projectName==unnamed convention as maybeNameSession), and
   * 'Untitled' keeps its existing mapping.
   */
  const displayTitle = (title: string, projectName: string): string =>
    title === projectName ? t('sidebar.newChat') : title === 'Untitled' ? t('history.untitled') : title
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
  const projectRecords = useProjects(state => state.projects)
  const archivedProjectPaths = useMemo(() => new Set(projectRecords.filter(project => project.archived).map(project => project.path)), [projectRecords])
  const defaultProjectPaths = useMemo(() => new Set(projectRecords.filter(project => project.isDefault).map(project => project.path)), [projectRecords])
  const projectNames = useMemo(() => new Map(projectRecords.map(project => [project.path, project.name])), [projectRecords])
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId)
  const setWorkspacePanel = useAppStore((s) => s.setWorkspacePanel)
  const setSessions = useAppStore((s) => s.setSessions)
  const setTheme = useAppStore((s) => s.setTheme)
  const togglePinSession = useAppStore((s) => s.togglePinSession)
  const setSessionArchived = useAppStore((s) => s.setSessionArchived)
  const addSession = useAppStore((s) => s.addSession)
  const setMessages = useAppStore((s) => s.setMessages)
  const loadHistorySessions = useAppStore((s) => s.loadHistorySessions)
  const removeHistorySession = useAppStore((s) => s.removeHistorySession)
  const purgeDeletedSession = useAppStore((s) => s.purgeDeletedSession)
  const setSetupComplete = useAppStore((s) => s.setSetupComplete)

  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
  const sessionMenuTrigger = useRef<HTMLButtonElement | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)
  // Inline rename of a live session row (pencil in the hover actions).
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [resumingHistoryId, setResumingHistoryId] = useState<string | null>(null)
  const resumingHistoryRef = useRef(false)
  const resumingGlobalRef = useRef(false)
  const openingLiveRef = useRef(false)
  const queuedOpen = useRef<{ intent: number; open: () => void } | null>(null)
  const [resumingGlobalUuid, setResumingGlobalUuid] = useState<string | null>(null)
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
  const loadScopedHistory = loadHistorySessions

  // Grant identity changes, rather than refreshed workspace objects, own reads.
  useEffect(() => {
    void loadScopedHistory(currentWorkspace?.id ?? null)
  }, [currentWorkspace?.id, loadScopedHistory])

  // Cross-project durable history: refresh on mount, on workspace change, and
  // whenever this window regains focus (another window may have added sessions).
  useEffect(() => {
    void loadAllHistorySessions()
    const onFocus = () => void loadAllHistorySessions()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [currentWorkspace?.realPath, loadAllHistorySessions])

  // Scheduled task state changes come from Main via push.
  useEffect(() => {
    return window.electronAPI.onTasksStateChanged(setScheduledTasks)
  }, [setScheduledTasks])

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
    let ok = false
    try {
      ok = await window.electronAPI.deleteSessionByUuid(currentWorkspace.id, uuid)
    } catch {
      // Caller surfaces the failure — never an unhandled rejection.
      ok = false
    }
    if (ok) purgeDeletedSession(uuid)
    void loadHistorySessions(currentWorkspace.id)
    void loadAllHistorySessions()
    return ok
  }

  const handleDeleteSession = async (id: string) => {
    // The durable identity must be captured before the kill: the record is the
    // renderer's only link between the runtime id and the transcript file.
    const record = recordByRuntimeId.get(id)
    let uuid = recordDurableUuid(record)
    if (!uuid) {
      // Last chance before the process dies: get_state carries the session
      // file, whose name embeds the durable uuid. Without it the sweep below
      // would silently skip and the transcript would resurrect as a history
      // row — reading as a broken delete button.
      try {
        const st = await window.electronAPI.getSessionState(id)
        if (st?.sessionFile) {
          uuid = sessionFileUuid(st.sessionFile)
          if (uuid) useAppStore.getState().setSessionFile(id, st.sessionFile)
        }
      } catch {
        // Session already dead — fall through to the kill with no uuid.
      }
    }
    window.electronAPI.killSession(id)
    setSessions(sessions.filter((s) => s.id !== id))
    if (currentSessionId === id) {
      setCurrentSessionId(null)
    }
    // A killed session's transcript stays on disk and would resurface in the
    // durable scan (immediately as a history row, after restart via the
    // cross-project list) — delete every copy of it too.
    const ok = await deleteByUuidAndRefresh(uuid)
    if (!ok) {
      // The transcript is still on disk; the rescan above will re-add it as a
      // history row. Surface that — never a silent no-op delete.
      showNotice('sidebar.deleteFailedDurable')
    }
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
    // Archiving kills the process, and a killed session drops its queued
    // messages without a trace. Say so before it happens — silent message
    // loss reads as a broken app.
    const queued = useAppStore.getState().queuedMessages[id]?.length ?? 0
    if (queued > 0) showNotice('sidebar.archiveClearedQueue')
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

  // Archiving a RUNNING session (or one holding queued messages) kills the
  // process and drops the queue — that needs a two-stage confirm, same as
  // delete. Idle sessions archive straight away.
  const archiveSessionConfirm = useConfirmId((id: string) => handleArchiveSession(id, true))
  const requestArchiveSession = (id: string) => {
    const running = Boolean(busy[id])
    const queued = (useAppStore.getState().queuedMessages[id]?.length ?? 0) > 0
    if (running || queued) archiveSessionConfirm.click(id)
    else handleArchiveSession(id, true)
  }

  const flushQueuedOpen = () => {
    if (resumingHistoryRef.current || resumingGlobalRef.current || openingLiveRef.current) return
    const next = queuedOpen.current
    queuedOpen.current = null
    if (next && isCurrentNavigationIntent(next.intent)) next.open()
  }

  const handleResumeHistory = async (info: HistorySessionDescriptor, expectedWorkspace?: string, epoch = beginNavigationIntent(), fromGlobal = false): Promise<boolean> => {
    if (!isCurrentNavigationIntent(epoch)) return false
    // While the list is reloading for a new workspace its entries may still
    // belong to the previous project — resuming one would use the new grant.
    if (resumingHistoryRef.current || openingLiveRef.current || (resumingGlobalRef.current && !fromGlobal)) {
      queuedOpen.current = { intent: epoch, open: () => void handleResumeHistory(info, expectedWorkspace, epoch) }
      return false
    }
    const targetWorkspace = expectedWorkspace ?? useAppStore.getState().currentWorkspace?.realPath
    const targetProject = useProjects.getState().projects.find(project => project.path === targetWorkspace)
    if (targetProject && (targetProject.missing || targetProject.archived) && await activateSidebarProject(targetProject.path, epoch) === 'unavailable') return false
    if (!isCurrentNavigationIntent(epoch)) return false
    const access = historyResumeGrant(useAppStore.getState(), info, expectedWorkspace)
    if (!access.ok) {
      showNotice(access.error === 'loading' ? 'history.loading' : access.error === 'project-not-added' ? 'sidebar.projectNotAdded' : 'history.restoreFailed')
      return false
    }
    const grant = access.grant
    resumingHistoryRef.current = true
    setResumingHistoryId(info.id)
    setRestoreFailedHistoryId(null)
    try {
      const result = await window.electronAPI.resumeSession(grant.id, info.id)
      if (result && 'error' in result) {
        // The session opened but its transcript could not be loaded. Keep the
        // row (it is NOT dead) and tell the user instead of showing a blank
        // chat that reads as data loss.
        setRestoreFailedHistoryId(info.id)
        showNotice('history.transcriptUnavailable')
        return false
      }
      if (!result) {
        setRestoreFailedHistoryId(info.id)
        showNotice('history.restoreFailed')
        // A dead row (file rewritten in place or removed) must not linger as
        // an unresumable, undeletable entry — rescan so it disappears.
        void loadHistorySessions(grant.id)
        void loadAllHistorySessions()
        return false
      }
      const { session, messages: restored, historicalAgents } = result
      // The main process titles a resumed session after the project dir;
      // prefer the richer title from the history entry when there is one.
      const projectName = basename(grant.displayPath)
      const title =
        (!session.title || session.title === projectName) && info.title !== 'Untitled'
          ? info.title
          : session.title
      // Opening is not interacting: the resumed row keeps the ORIGINAL
      // conversation's recency until the user actually sends something.
      const selected = finishHistoryResume(grant, {
        save: () => {
          addSession({ ...session, title, lastActivityAt: info.timestamp }, false)
          setMessages(session.id, restored)
          // The live row replaces the old opaque history capability.
          removeHistorySession(info.id)
          useAppStore.getState().applyHistoricalAgents(session.id, historicalAgents ?? [])
        },
        currentWorkspace: () => isCurrentNavigationIntent(epoch) ? useAppStore.getState().currentWorkspace : null,
        select: () => { setCurrentSessionId(session.id, epoch); navigate('/') }
      })
      if (!selected && isCurrentNavigationIntent(epoch)) showNotice('history.restoredInOtherProject')
      return selected
    } catch {
      setRestoreFailedHistoryId(info.id)
      showNotice('history.restoreFailed')
      return false
    } finally {
      resumingHistoryRef.current = false
      setResumingHistoryId(null)
      flushQueuedOpen()
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
  const handleOpenGlobal = async (row: (typeof globalHistory)[number], epoch = beginNavigationIntent()) => {
    if (resumingGlobalRef.current || resumingHistoryRef.current || openingLiveRef.current) {
      queuedOpen.current = { intent: epoch, open: () => void handleOpenGlobal(row, epoch) }
      return
    }
    resumingGlobalRef.current = true
    setResumingGlobalUuid(row.uuid)
    try {
      if (await activateSidebarProject(row.cwd, epoch) === 'unavailable') return
      if (!isCurrentNavigationIntent(epoch)) return
      const result = await openGlobalHistory(row, {
        getState: useAppStore.getState,
        activateWorkspace: async id => {
          const before = useAppStore.getState()
          const grant = await window.electronAPI.activateRecentWorkspace(id)
          const latest = useAppStore.getState()
          if (grant && isCurrentNavigationIntent(epoch) && latest.currentWorkspace?.id === before.currentWorkspace?.id && latest.currentSessionId === before.currentSessionId) latest.setCurrentWorkspace(grant)
        },
        loadHistory: id => {
          const state = useAppStore.getState()
          if (!state.historyLoading && state.sessionRecords.some(record => !record.isLive && record.workspaceRealPath === row.cwd && record.history?.uuid === row.uuid)) return Promise.resolve()
          return loadScopedHistory(id)
        },
        resume: (info, workspace) => handleResumeHistory(info, workspace, epoch, true)
      })
      if (result === 'loading') showNotice('history.loading')
      else if (result === 'project-not-added') showNotice('sidebar.projectNotAdded')
      else if (result === 'history-unavailable') showNotice('history.restoreFailed')
    } finally { resumingGlobalRef.current = false; setResumingGlobalUuid(null); flushQueuedOpen() }
  }

  const handleOpenLive = async (session: (typeof sessions)[number], epoch = beginNavigationIntent()) => {
    queuedOpen.current = null
    if (openingLiveRef.current) { queuedOpen.current = { intent: epoch, open: () => void handleOpenLive(session, epoch) }; return }
    if ((resumingGlobalRef.current || resumingHistoryRef.current) && useAppStore.getState().currentWorkspace?.realPath !== session.cwd) {
      queuedOpen.current = { intent: epoch, open: () => void handleOpenLive(session, epoch) }
      return
    }
    openingLiveRef.current = true
    try {
      const target = await activateSidebarProject(session.cwd, epoch)
      if (target === 'unavailable') return
      if (target === 'legacy' && useAppStore.getState().currentWorkspace?.realPath !== session.cwd) {
        const before = useAppStore.getState()
        const recent = before.recentWorkspaces.find(item => item.displayPath === session.cwd)
        const grant = recent ? await window.electronAPI.activateRecentWorkspace(recent.id) : null
        const latest = useAppStore.getState()
        if (grant && isCurrentNavigationIntent(epoch) && latest.currentWorkspace?.id === before.currentWorkspace?.id && latest.currentSessionId === before.currentSessionId) latest.setCurrentWorkspace(grant)
      }
      if (!isCurrentNavigationIntent(epoch)) return
      if (useAppStore.getState().currentWorkspace?.realPath !== session.cwd) { showNotice('sidebar.projectNotAdded'); return }
      if (!useAppStore.getState().sessions.some(item => item.id === session.id)) return
      setCurrentSessionId(session.id, epoch)
      navigate('/')
    } finally { openingLiveRef.current = false; flushQueuedOpen() }
  }

  // Modal delete confirmation (same centered-dialog pattern as rename): the
  // old two-stage inline confirm could not be cancelled once armed and never
  // said WHAT gets removed — deleting takes every durable copy of the uuid.
  // Sidebar rows glide to their new slot when order changes (session floats
  // to top on switch-away) instead of jump-cutting.
  const listRef = useRef<HTMLDivElement | null>(null)
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'live' | 'history' | 'global'; id: string; title: string } | null
  >(null)
  const renameDialogRef = useRef<HTMLDivElement>(null)
  useModalBoundary(renameDialogRef, Boolean(renamingId), () => setRenamingId(null))
  const confirmPendingDelete = () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    if (target.kind === 'live') {
      void handleDeleteSession(target.id)
    } else if (target.kind === 'history') {
      setDeleteFailedHistoryId(null)
      const info = visibleHistory.find((entry) => entry.id === target.id)
      if (info) void handleDeleteHistory(info)
    } else {
      setDeleteFailedGlobalUuid(null)
      const row = globalHistory.find((entry) => entry.uuid === target.id)
      if (row) void handleDeleteGlobal(row)
    }
  }

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

  // ---- unified "最近" flat list ------------------------------------------
  // Live sessions (every project), workspace-bound history rows, and the
  // cross-project durable scan merge into one list. The durable scan is what
  // makes the sidebar survive restarts. Rows of projects other than the
  // active one carry their project as a suffix.

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
  type RecentEntry = SidebarConversation

  const allEntries = useMemo(() => sidebarConversations({
    sessions, records: sessionRecords, globalHistory,
    currentPath: currentWorkspace?.realPath ?? null,
    archivedProjects: archivedProjectPaths, pinned: pinnedSet
  }), [sessions, sessionRecords, globalHistory, currentWorkspace?.realPath, archivedProjectPaths, pinnedSet])

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
    `icon-pop group flex h-8 w-full items-center gap-2.5 rounded-lg border px-2.5 text-[13px] transition-all duration-150 ease-standard ${
      active
        ? 'border-transparent bg-selected font-medium text-cream'
        : 'border-transparent text-cream-dim hover:bg-overlay hover:text-cream'
    }`

  const iconBtn =
    'shrink-0 rounded-md p-1 text-cream-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100'

  // Action slots reserve their width; hovering never moves the select button.

  // Provenance chip shared by live, history and cross-project rows: a session
  // spawned by a Feishu route or a scheduled task keeps its badge even after
  // the in-memory registry is gone (origin rides the durable index).
  const renderOriginBadge = (origin?: 'feishu' | 'task') => {
    if (origin !== 'feishu' && origin !== 'task') return null
    return (
      <span
        className="shrink-0 rounded border border-line px-1 text-[9px] font-medium leading-[14px] text-cream-faint"
        title={origin === 'feishu' ? t('sidebar.feishuSession') : t('sidebar.taskSession')}
      >
        {origin === 'feishu' ? t('sidebar.badge.feishu') : t('sidebar.badge.task')}
      </span>
    )
  }

  const commitRename = () => {
    const id = renamingId
    const name = cleanSessionName(renameDraft)
    if (!id || !name) return
    const session = sessions.find((s) => s.id === id)
    if (!session || session.title === name) {
      setRenamingId(null)
      return
    }
    // Main persists the name durably. On failure (typically the runtime is
    // mid-turn and the control query times out) keep the dialog open with
    // the draft intact — the user retries after the turn instead of losing
    // the edit.
    void window.electronAPI
      .setSessionName(id, name)
      .then((result) => {
        if (result) {
          setRenamingId(null)
          useAppStore.getState().setSessionTitle(id, result.title)
        } else {
          showNotice('sidebar.renameFailed')
        }
      })
      .catch(() => showNotice('sidebar.renameFailed'))
  }

  const renderSessionRow = (session: (typeof sessions)[number], key: string) => {
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
    const foreignWorkspace = session.cwd !== currentWorkspace?.realPath && !defaultProjectPaths.has(session.cwd)
    return (
      <div
        key={key}
        data-conversation-key={key}
        className={`group flex items-center gap-1 rounded-lg border border-transparent px-2 py-0.5 transition-colors duration-150 ${
          active ? 'bg-selected' : 'hover:bg-overlay'
        }`}
      >
        <button type="button" data-conversation-select onClick={() => void handleOpenLive(session)}
          title={displayTitle(session.title, basename(session.cwd) || session.cwd)}
          aria-label={`${displayTitle(session.title, basename(session.cwd) || session.cwd)}, ${statusLabel}`} aria-current={active ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
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
        <span className="min-w-0 flex-1">
          <span
            className={`flex min-w-0 items-center gap-1.5 ${
              dead ? 'text-cream-faint line-through' : 'text-cream'
            }`}
          >
            {/* Untitled new chats show the placeholder — see displayTitle. */}
            <span className="min-w-0 truncate text-[13px] font-medium leading-5">
              {displayTitle(session.title, basename(session.cwd) || session.cwd)}
            </span>
            {renderOriginBadge(session.origin)}
            {pinned && <Pin size={10} className="shrink-0 text-accent" aria-hidden="true" />}
          </span>
          <span className="block truncate text-[11px] leading-4 text-cream-faint">
            {foreignWorkspace
              ? `${projectNames.get(session.cwd) || basename(session.cwd) || session.cwd} · ${formatRelativeTime(session.lastActivityAt ?? session.createdAt, language)}`
              : formatRelativeTime(session.lastActivityAt ?? session.createdAt, language)}
            <span className={`ml-1 text-[10px] font-medium ${
            status === 'error'
              ? 'text-red-500'
              : status === 'attention'
                ? 'text-red-400'
                : status === 'running'
                  ? 'text-amber-400'
                  : status === 'unread'
                    ? 'text-accent'
                    : 'text-cream-faint/70'
            }`}>{statusLabel}</span>
          </span>
        </span>
        </button>
        <button type="button" data-session-actions={session.id}
          aria-label={t('sidebar.sessionActions', { title: displayTitle(session.title, basename(session.cwd) || session.cwd) })}
          title={t('sidebar.sessionActions', { title: displayTitle(session.title, basename(session.cwd) || session.cwd) })}
          aria-haspopup="menu" aria-expanded={sessionMenuId === session.id && sessionMenuTrigger.current?.dataset.sessionActions === session.id}
          onClick={event => {
            const same = sessionMenuId === session.id && sessionMenuTrigger.current === event.currentTarget
            sessionMenuTrigger.current = event.currentTarget
            archiveSessionConfirm.reset()
            setSessionMenuId(same ? null : session.id)
          }}
          className="shrink-0 rounded-md p-1.5 text-cream-faint transition-colors hover:bg-overlay-strong hover:text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <MoreHorizontal size={14} />
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
        void handleOpenLive(entry.session)
        return
      }
      setSessionArchived(entry.kind === 'history' ? entry.info.uuid : entry.row.uuid, false)
      if (entry.kind === 'history') void handleResumeHistory(entry.info)
      else void handleOpenGlobal(entry.row)
    }
    const confirmDelete = () => {
      if (entry.kind === 'live') setPendingDelete({ kind: 'live', id: entry.session.id, title: entry.session.title })
      else if (entry.kind === 'history') setPendingDelete({ kind: 'history', id: entry.info.id, title: entry.info.title })
      else setPendingDelete({ kind: 'global', id: entry.row.uuid, title: entry.row.title })
    }
    return (
      <div
        key={entry.key}
        data-conversation-key={entry.key}
        className="group flex items-center gap-2 rounded-lg px-2.5 py-[6px] transition-colors duration-150 hover:bg-overlay"
      >
        <button type="button" data-conversation-select onClick={unarchiveAndOpen} title={entry.title}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <span className="block truncate text-[13px] leading-5 text-cream-faint">
            {displayTitle(entry.title, entry.projectName)}
          </span>
          <span className="block truncate text-[11px] leading-4 text-cream-faint/70">
            {defaultProjectPaths.has(entry.workspacePath) ? formatRelativeTime(entry.timestamp, language) : `${projectNames.get(entry.workspacePath) || entry.projectName} · ${formatRelativeTime(entry.timestamp, language)}`}
          </span>
        </button>
        <button
          type="button"
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
          type="button"
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

  const renderHistoryRow = (info: HistorySessionDescriptor, key: string) => {
    const resuming = resumingHistoryId === info.id
    const failed = restoreFailedHistoryId === info.id
    return (
      <div
        key={key}
        data-conversation-key={key}
        className={`group flex items-center gap-2 rounded-lg px-2.5 py-[6px] transition-colors duration-150 hover:bg-overlay ${resuming ? 'opacity-60' : ''}`}
      >
        <button type="button" data-conversation-select disabled={resuming} onClick={() => void handleResumeHistory(info)} title={info.title}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] leading-5 text-cream-dim">
              {displayTitle(info.title, basename(currentWorkspace?.realPath ?? ''))}
            </span>
            {renderOriginBadge(info.origin)}
          </span>
          <span
            className={`block truncate text-[11px] leading-4 ${
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
          </span>
        </button>
        {resuming ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-cream-faint" />
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setPendingDelete({ kind: 'history', id: info.id, title: info.title })
            }}
            title={t('history.delete')}
            className={`${iconBtn} hover:bg-red-500/15 hover:text-red-500`}
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
  const renderGlobalRow = (row: (typeof globalHistory)[number], key: string) => {
    // Only the row being resumed greys and locks — one pending resume must
    // not freeze every cross-project row in the list.
    const resuming = resumingGlobalUuid === row.uuid
    return (
      <div
        key={key}
        data-conversation-key={key}
        className={`group flex items-center gap-2 rounded-lg px-2.5 py-[6px] transition-colors duration-150 hover:bg-overlay ${resuming ? 'opacity-60' : ''}`}
      >
        <button type="button" data-conversation-select disabled={resuming} onClick={() => void handleOpenGlobal(row)} title={defaultProjectPaths.has(row.cwd) ? row.title : row.cwd}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] leading-5 text-cream-dim">
              {displayTitle(row.title, basename(row.cwd) || row.cwd)}
            </span>
            {renderOriginBadge(row.origin)}
          </span>
          <span
            className={`block truncate text-[11px] leading-4 ${
              deleteFailedGlobalUuid === row.uuid ? 'text-red-500' : 'text-cream-faint/70'
            }`}
          >
            {deleteFailedGlobalUuid === row.uuid
              ? t('history.deleteFailed')
              : defaultProjectPaths.has(row.cwd) ? formatRelativeTime(row.timestamp, language) : `${projectNames.get(row.cwd) || basename(row.cwd) || row.cwd} · ${formatRelativeTime(row.timestamp, language)}`}
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setPendingDelete({ kind: 'global', id: row.uuid, title: row.title })
          }}
          title={t('history.delete')}
          className={`${iconBtn} hover:bg-red-500/15 hover:text-red-500`}
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
    if (entry.kind === 'live') return renderSessionRow(entry.session, entry.key)
    if (entry.kind === 'history') return renderHistoryRow(entry.info, entry.key)
    return renderGlobalRow(entry.row, entry.key)
  }

  const menuSession = sessions.find(session => session.id === sessionMenuId)
  const closeSessionMenu = () => {
    setSessionMenuId(null)
    archiveSessionConfirm.reset()
  }

  const projectConversations = useMemo(() => {
    const grouped = new Map<string, RecentEntry[]>()
    for (const entry of recentEntries) {
      const rows = grouped.get(entry.workspacePath) ?? []
      rows.push(entry)
      grouped.set(entry.workspacePath, rows)
    }
    return grouped
  }, [recentEntries])

  return (
    <aside
      ref={asideRef}
      style={{ width: sidebarWidth }}
      className="app-sidebar relative flex shrink-0 flex-col border-r border-line bg-ink-900 max-w-[min(360px,30vw)]"
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

      <div className="app-drag app-sidebar-brand flex items-center justify-between px-4 pb-3">
        <div className="flex items-center gap-2.5">
          <Logo size={22} className="shrink-0" />
          <span className="text-[15px] font-semibold tracking-tight text-cream">投手</span>
        </div>
      </div>

      <div className="px-3 pb-3">
        <div className="app-view-segment" role="tablist" aria-label={t('sidebar.mode.label')}>
          <button
            type="button"
            role="tab"
            aria-selected={location.pathname === '/boards'}
            aria-pressed={location.pathname === '/boards'}
            onClick={() => navigate('/boards')}
            className="focus-ring flex items-center justify-center gap-1.5 px-2 text-[12px] font-medium"
          >
            <BriefcaseBusiness size={14} aria-hidden="true" />
            <span>{t('sidebar.mode.buying')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={location.pathname === '/'}
            aria-pressed={location.pathname === '/'}
            onClick={() => {
              setWorkspacePanel(null)
              navigate('/')
            }}
            className="focus-ring flex items-center justify-center gap-1.5 px-2 text-[12px] font-medium"
          >
            <MessageSquare size={14} aria-hidden="true" />
            <span>{t('sidebar.mode.agent')}</span>
          </button>
        </div>
      </div>

      <nav className="space-y-0.5 px-3" aria-label={t('sidebar.primaryNav')}>
        {/* 新建会话 = 回首页 + 清空选中。会话只在第一条消息发出时创建（⌘N 同效）。 */}
        <button
          onClick={() => {
            queuedOpen.current = null
            setCurrentSessionId(null)
            navigate('/')
          }}
          className={navRow(location.pathname === '/' && !currentSessionId)}
        >
          <MessageSquare size={14} className="shrink-0" />
          {t('sidebar.newChat')}
          <span className="kbd ml-auto opacity-0 transition-opacity group-hover:opacity-100">{modShortcut('N')}</span>
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

      <SidebarProjects renderConversations={path => projectConversations.get(path)?.map(renderRecentEntry)} />

      {/* Running task count */}
      {runningCount > 0 && (
        <div className="mx-2.5 mt-2 flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          {t('sidebar.runningCount', { count: runningCount })}
        </div>
      )}

      <div className="mt-5 min-h-[128px] flex-1 overflow-y-auto px-2.5 pb-4" ref={listRef} data-all-conversations>
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
                className={`absolute top-0.5 h-2.5 w-2.5 rounded-full transition-[left,background-color] ${
                  showArchived ? 'left-[12px] bg-ink-950' : 'left-0.5 bg-cream'
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
          filteredRecentEntries.length === 0 ? (
            <div className="px-2 py-1.5 text-xs leading-5 text-cream-faint">{t('sidebar.noMatch')}</div>
          ) : (
            <div className="space-y-0.5">{filteredRecentEntries.map(renderRecentEntry)}</div>
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
          aria-label={t('sidebar.settings')}
          aria-current={location.pathname === '/settings' ? 'page' : undefined}
          className={`focus-ring flex min-h-8 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors ${
            location.pathname === '/settings'
              ? 'bg-overlay-strong text-cream'
              : 'text-cream-faint hover:bg-overlay hover:text-cream'
          }`}
        >
          <Settings size={15} />
          <span>{t('sidebar.settings')}</span>
        </button>
        <button
          onClick={(e) => runThemeTransition(() => setTheme(theme === 'dark' ? 'light' : 'dark'), { x: e.clientX, y: e.clientY }, theme === 'dark' ? 'light' : 'dark')}
          title={t('sidebar.theme')}
          aria-label={t('sidebar.theme')}
          className="focus-ring ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-cream-faint transition-colors hover:bg-overlay hover:text-cream"
        >
          <span key={theme} className="theme-icon">{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</span>
        </button>
      </div>

      <MenuPortal open={Boolean(menuSession)} triggerRef={sessionMenuTrigger} onClose={closeSessionMenu} width={208} placement="bottom">
        {menuSession && <div data-session-action-menu={menuSession.id}>
          <div className="truncate px-2.5 py-2 text-xs font-medium text-cream" title={menuSession.title}>{displayTitle(menuSession.title, basename(menuSession.cwd) || menuSession.cwd)}</div>
          <button type="button" data-session-action="pin" className="project-menu-action" onClick={() => { togglePinSession(menuSession.id); closeSessionMenu(); sessionMenuTrigger.current?.focus() }}>
            {pinnedSet.has(menuSession.id) ? <PinOff size={13} /> : <Pin size={13} />}{t(pinnedSet.has(menuSession.id) ? 'sidebar.unpin' : 'sidebar.pin')}
          </button>
          <button type="button" data-session-action="rename" className="project-menu-action" onClick={() => { closeSessionMenu(); sessionMenuTrigger.current?.focus(); setRenamingId(menuSession.id); setRenameDraft(menuSession.title) }}><Pencil size={13} />{t('sidebar.rename')}</button>
          <button type="button" data-session-action="archive" className={`project-menu-action ${archiveSessionConfirm.confirmingId === menuSession.id ? 'text-red-500' : ''}`} onClick={() => {
            const needsConfirm = Boolean(busy[menuSession.id]) || (useAppStore.getState().queuedMessages[menuSession.id]?.length ?? 0) > 0
            const confirmed = archiveSessionConfirm.confirmingId === menuSession.id
            requestArchiveSession(menuSession.id)
            if (!needsConfirm || confirmed) closeSessionMenu()
          }}><Archive size={13} />{t(archiveSessionConfirm.confirmingId === menuSession.id ? 'sidebar.archiveConfirm' : 'sidebar.archive')}</button>
          <button type="button" data-session-action="delete" className="project-menu-action text-red-500" onClick={() => { closeSessionMenu(); sessionMenuTrigger.current?.focus(); setPendingDelete({ kind: 'live', id: menuSession.id, title: menuSession.title }) }}><Trash2 size={13} />{t('sidebar.deleteSession')}</button>
        </div>}
      </MenuPortal>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-line bg-ink-850 px-3.5 py-1.5 text-xs text-cream shadow-pop"
        >
          {t(notice.key)}
        </div>
      )}
      {renamingId && (
        // Modal rename: the sidebar column is too narrow to edit a 60-char
        // title inline — a centered dialog gives the input real width.
        // The backdrop deliberately does NOT cancel: a stray click outside
        // must not eat a half-edited title. Explicit ✕ / Escape cancels;
        // ✓ / Enter commits.
        <div className="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            ref={renameDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('sidebar.rename')}
            tabIndex={-1}
            className="dialog-panel w-96 rounded-xl border border-line bg-ink-900 p-4 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[12px] font-medium text-cream">{t('sidebar.rename')}</div>
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
              }}
              maxLength={60}
              aria-label={t('sidebar.rename')}
              className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[13px] text-cream outline-none transition focus:border-accent/50"
            />
            <div className="mt-3 flex justify-end gap-1.5">
              <button
                onClick={() => setRenamingId(null)}
                className="rounded-full border border-line px-3 py-1 text-[11.5px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
              >
                {t('sidebar.renameCancel')}
              </button>
              <button
                onClick={commitRename}
                disabled={!renameDraft.trim()}
                className="rounded-full bg-cream px-3 py-1 text-[11.5px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
              >
                {t('sidebar.renameSave')}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingDelete && (
        // The shared destructive-confirm dialog (same component as every
        // other permanent deletion) — one Escape/Cancel contract everywhere.
        <ConfirmDialog
          request={{
            title: t('sidebar.deleteDialog.title'),
            body: t('sidebar.deleteDialog.body', {
              title: pendingDelete.title === 'Untitled' ? t('history.untitled') : pendingDelete.title
            }),
            confirmLabel: t('sidebar.deleteDialog.confirm'),
            danger: true,
            onConfirm: confirmPendingDelete
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </aside>
  )
}
