import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FolderOpen,
  MessageSquare,
  Download,
  Loader2,
  ChevronDown,
  PanelRight,
  LayoutDashboard,
  CalendarClock,
  Clock3,
  Layers,
  Plug,
  BookOpen,
  Puzzle,
  Settings2,
  BarChart3,
  Globe2,
  Table2,
  CircleAlert
} from 'lucide-react'
import { PromptImage, SlashCommand } from '@shared/types'
import { MessageLike, UiRequest, useAppStore } from '../store'
import { useProjects } from '../store/projects'
import { I18nKey, useT } from '../i18n'
import { showNotice } from '../lib/notice'
import { createSessionForCurrentProject } from '../lib/session'
import { captureSessionSnapshot } from '../lib/runtimeSnapshot'
import { exportFilename } from '../lib/exportFilename'
import { basename } from '../lib/path'
import MessageList from './MessageList'
import ExecutionActivity from './ExecutionActivity'
import Composer from './Composer'
import ProjectRecovery from './ProjectRecovery'
import ExtensionUiDialog from './ExtensionUiDialog'
import GitChip from './GitChip'
import OpenWithMenu from './OpenWithMenu'
import useElementWidth from '../lib/useElementWidth'
import { retryFailedMessage } from '../lib/retryMessage'
import { useTranscriptScroll } from '../lib/useTranscriptScroll'

const EMPTY_MESSAGES: MessageLike[] = []
const EMPTY_UI_REQUESTS: UiRequest[] = []

/** Below this chat-column width the header/toolbar collapse to icon-only. */
const COMPACT_BREAKPOINT = 760


export default function ChatPanel() {
  const t = useT()
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  // Background metadata keeps this object reference, so it must not rerender
  // the active transcript/composer just because another session was renamed.
  const currentSession = useAppStore((s) => s.sessions.find(session => session.id === s.currentSessionId))
  // History preview (preview:<historyId>): the peeked transcript renders while
  // the runtime resume continues in the background. Input stays gated until the
  // live session swaps in — a failed resume keeps the conversation readable.
  const sessionPreview = useAppStore((s) =>
    s.currentSessionId?.startsWith('preview:') ? s.sessionPreviews[s.currentSessionId] : undefined
  )
  const previewActive = Boolean(sessionPreview)
  const cliAvailable = useAppStore((s) => s.cliAvailable)
  const workspacePanel = useAppStore((s) => s.workspacePanel)
  const setWorkspacePanel = useAppStore((s) => s.setWorkspacePanel)
  const selectWorkspace = useProjects((s) => s.importFolder)
  const unavailableDefault = useProjects(s => s.projects.find(project => project.isDefault && project.missing))
  // Per-session slices only: streaming deltas of OTHER sessions must not
  // re-render this chat, and unrelated store writes must not either.
  const sessionMessages = useAppStore((s) =>
    currentSessionId ? s.messages[currentSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  )
  const isBusy = useAppStore((s) =>
    currentSessionId ? Boolean(s.busy[currentSessionId]) : false
  )

  const isCompacting = useAppStore((s) =>
    currentSessionId ? Boolean(s.compacting[currentSessionId]) : false
  )
  const pendingUi = useAppStore((s) =>
    currentSessionId ? (s.uiRequests[currentSessionId] ?? EMPTY_UI_REQUESTS)[0] : undefined
  )
  const sessionError = useAppStore((s) =>
    currentSessionId ? s.sessionErrors[currentSessionId] : undefined
  )
  const queuedCount = useAppStore((s) => currentSessionId ? s.queuedMessages[currentSessionId]?.length ?? 0 : 0)
  const queuePauseReason = useAppStore((s) => currentSessionId ? s.queuePauseReasons[currentSessionId] : undefined)
  const queueDispatching = useAppStore((s) => currentSessionId ? s.queueDispatching[currentSessionId] : undefined)
  const { viewportRef: scrollRef, contentRef, onScroll: handleTranscriptScroll, showJump, jumpToBottom } = useTranscriptScroll(currentSessionId)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])
  const navigate = useNavigate()
  // Built-in slash commands: available in the palette everywhere (home and
  // chat) — app commands must not depend on a live session. Deps are stable
  // across streaming renders, so the memoized Composer's props hold.
  const appCommands = useMemo(
    () => [
      {
        name: 'new',
        description: t('slash.new'),
        icon: MessageSquare,
        run: () => useAppStore.getState().setCurrentSessionId(null)
      },
      { name: 'mcp', description: t('slash.mcp'), icon: Plug, run: () => navigate('/connections') },
      {
        name: 'tiktok',
        description: t('slash.tiktok'),
        icon: BarChart3,
        run: () => useAppStore.getState().setComposerPrefill(t('slash.tiktokPrompt'))
      },
      { name: 'tasks', description: t('slash.tasks'), icon: CalendarClock, run: () => navigate('/tasks') },
      { name: 'boards', description: t('slash.boards'), icon: LayoutDashboard, run: () => navigate('/boards') },
      { name: 'skills', description: t('slash.skills'), icon: BookOpen, run: () => navigate('/skills') },
      { name: 'plugins', description: t('slash.plugins'), icon: Puzzle, run: () => navigate('/plugins') },
      { name: 'settings', description: t('slash.settings'), icon: Settings2, run: () => navigate('/settings') }
    ],
    [t, navigate]
  )
  const [exporting, setExporting] = useState(false)
  const [exportFailed, setExportFailed] = useState(false)
  const [exportSuccessPath, setExportSuccessPath] = useState<string | null>(null)
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null)
  const [recoveringQueue, setRecoveringQueue] = useState(false)
  const preparingPrompts = useRef(new Map<string, string>())
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stoppingBusy = useAppStore((s) =>
    stoppingSessionId ? Boolean(s.busy[stoppingSessionId]) : false
  )
  // Session-less send failure (create threw — e.g. a stale workspace grant)
  const [sendError, setSendError] = useState<I18nKey | null>(null)
  // Home hero: inline "new project folder" naming state

  const isStopping = currentSessionId !== null && stoppingSessionId === currentSessionId
  const closedQueue = queuePauseReason === 'closed' || currentSession?.status === 'error'
  const actionError = sessionError === 'chat.stopFailed' || sessionError === 'chat.steerComposerFailed' || sessionError === 'chat.steerQueueFailed'
  const statusError = !isBusy || actionError ? sessionError ?? sendError : null

  // The browser panel (or a small window) squeezes this column; compact
  // flips once when the column crosses the breakpoint, never per pixel.
  const { ref: columnRef, compact } = useElementWidth<HTMLDivElement>(COMPACT_BREAKPOINT)

  const toggleWorkspace = () => {
    if (workspacePanel) {
      setWorkspacePanel(null)
      return
    }
    setWorkspacePanel({ kind: 'browser' })
  }

  // A terminal runtime event confirms Stop. Until then the local state gives
  // immediate feedback and prevents a second abort click.
  useEffect(() => {
    if (!stoppingSessionId || stoppingBusy) return
    setStoppingSessionId(null)
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
  }, [stoppingBusy, stoppingSessionId])

  useEffect(
    () => () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    },
    []
  )

  // Slash commands come from the live session (extensions/prompts/skills)
  useEffect(() => {
    if (!currentSessionId) {
      setSlashCommands([])
      return
    }
    let cancelled = false
    window.electronAPI.listCommands(currentSessionId).then((cmds) => {
      if (!cancelled) setSlashCommands(cmds)
    })
    return () => {
      cancelled = true
    }
  }, [currentSessionId])

  // First-message spawn wait: the user sees an honest "creating session" row
  // instead of a cleared composer and silence (学 dsh 的 pending echo 思路).
  const [creatingSession, setCreatingSession] = useState(false)

  // useCallback-stabilized: Composer is memoized, so identity-stable handlers
  // are what let the input surface skip streaming re-renders entirely.
  const handleSend = useCallback(
    async (text: string, images?: PromptImage[]): Promise<boolean> => {
      const trimmed = text.trim()
      if (!trimmed || cliAvailable === false) return false
      // Preview sessions are read-only; the live swap-in re-enables the composer.
      if (currentSessionId?.startsWith('preview:')) return false
      let sessionId = currentSessionId
      if (!sessionId) {
        setCreatingSession(true)
        try {
          sessionId = await createSessionForCurrentProject()
        } catch (err) {
          // Session creation throws on an invalid grant — fail loudly and let
          // the composer restore the draft instead of losing it to a rejection.
          console.error('Session creation failed:', err)
          setSendError('chat.createFailed')
          setTimeout(() => setSendError(null), 3000)
          return false
        } finally {
          setCreatingSession(false)
        }
        if (!sessionId) {
          // No workspace could be resolved (default workspace creation failed).
          setSendError('chat.createFailed')
          setTimeout(() => setSendError(null), 3000)
          return false
        }
      }
      const store = useAppStore.getState()
      const liveSession = store.sessions.find((session) => session.id === sessionId)
      if (store.currentSessionId === sessionId && liveSession && store.currentWorkspace && liveSession.cwd !== store.currentWorkspace.realPath) {
        store.setSessionError(sessionId, 'chat.queueWorkspaceChanged')
        return false
      }
      if (store.busy[sessionId] || store.queueDispatching[sessionId]) return false
      store.setSessionError(sessionId, null)
      // The user bubble lands immediately; the runtime snapshot below (a
      // get_state RPC with an 8s timeout on a hung session) resolves
      // concurrently and tags the message whenever it comes back.
      const snapshot = captureSessionSnapshot(sessionId)
      const messageId = crypto.randomUUID()
      preparingPrompts.current.set(sessionId, messageId)
      store.setBusy(sessionId, true)
      store.addMessage(sessionId, {
        id: messageId,
        role: 'user',
        kind: 'prompt',
        content: trimmed,
        images: images?.map(({ data, mimeType }) => ({ data, mimeType }))
      })
      // Snapshot the worktree BEFORE the prompt can make its first edit, so the
      // checkpoint really is the "before" state of this turn. A checkpoint
      // failure must never swallow the prompt: send it, but tell the user
      // rollback won't be available for this turn.
      const list = useAppStore.getState().messages[sessionId] || []
      try {
        await store.createCheckpointForMessage(sessionId, list.length - 1, trimmed)
      } catch {
        store.setSessionError(sessionId, 'chat.checkpointFailed')
      }
      if (preparingPrompts.current.get(sessionId) !== messageId) {
        store.updateMessage(sessionId, messageId, { failed: true })
        return false
      }
      preparingPrompts.current.delete(sessionId)
      const sent = await window.electronAPI.sendMessage(sessionId, trimmed, images).catch(() => null)
      if (sent !== true) {
        store.setBusy(sessionId, false)
        store.pauseQueuedMessages(sessionId, sent === null ? 'unknown' : 'failed')
        if (useAppStore.getState().sessionErrors[sessionId] !== 'chat.sessionDead') {
          store.setSessionError(sessionId, sent === null ? 'chat.queueDeliveryUnknown' : 'chat.sendFailed')
        }
        store.updateMessage(sessionId, messageId, sent === null ? { deliveryUnknown: true } : { failed: true })
        return false
      }
      store.touchSession(sessionId)
      // Tag the turn with the ACTUAL dispatch-time model/thinking — the
      // historical turn keeps what it ran under, never later session state.
      void snapshot.then((snap) => {
        useAppStore.getState().updateMessage(sessionId, messageId, {
          runtimeModel: snap.modelSelector,
          runtimeThinking: snap.thinkingLevel
        })
      })
      // First user message of an untitled session becomes its name
      void store.maybeNameSession(sessionId)
      return true
    },
    [currentSessionId, cliAvailable]
  )

  const handleRetry = useCallback(async (sessionId: string, message: MessageLike): Promise<boolean> => {
    const state = useAppStore.getState()
    return retryFailedMessage(sessionId, message, {
      currentSessionId: state.currentSessionId,
      busy: Boolean(state.busy[sessionId]),
      enqueue: state.enqueueQueuedMessage,
      send: handleSend,
      createId: () => crypto.randomUUID()
    })
  }, [handleSend])

  const handleExport = async () => {
    if (!currentSessionId || exporting) return
    setExporting(true)
    setExportFailed(false)
    setExportSuccessPath(null)
    try {
      const saved = await window.electronAPI.exportHtml(currentSessionId)
      if (!saved) throw new Error('exportHtml returned null')
      setExportSuccessPath(saved)
      setTimeout(() => setExportSuccessPath((current) => (current === saved ? null : current)), 3500)
    } catch (err) {
      console.error('Session export failed:', err)
      setExportFailed(true)
      setTimeout(() => setExportFailed(false), 2000)
    } finally {
      setExporting(false)
    }
  }

  const handleStop = useCallback(async () => {
    const sid = currentSessionId
    if (!sid || stoppingSessionId === sid) return
    const store = useAppStore.getState()
    // Pause before asking Main to stop, including while a queue head is
    // still taking its pre-send checkpoint.
    store.pauseQueuedMessages(sid, 'stopped')
    if (preparingPrompts.current.delete(sid)) {
      store.setBusy(sid, false)
      return
    }
    if (store.queueDispatching[sid]?.phase === 'checkpoint') return
    setStoppingSessionId(sid)
    // Cancel pending dialogs first: an unanswered select/confirm holds the
    // turn open, and aborting underneath it wedges the session as busy
    // forever (no agent_end ever arrives).
    try {
      for (const req of store.uiRequests[sid] || []) {
        const answered = await window.electronAPI.respondUi(sid, req.id, { cancelled: true })
        // Do not pretend an upstream dialog is gone if the response could not
        // be written. A successful abort/close will clear it authoritatively.
        if (answered) store.resolveUiRequest(sid, req.id)
      }
      const accepted = await window.electronAPI.abortSession(sid)
      if (!accepted) throw new Error('abortSession rejected')
      stopTimerRef.current = setTimeout(() => {
        const current = useAppStore.getState()
        if (current.busy[sid]) {
          setStoppingSessionId(null)
          current.setSessionError(sid, 'chat.stopFailed')
        }
      }, 8000)
    } catch (err) {
      console.error('Session stop failed:', err)
      setStoppingSessionId(null)
      store.setSessionError(sid, 'chat.stopFailed')
    }
  }, [currentSessionId, stoppingSessionId])

  const recoverQueuedMessages = async () => {
    if (!currentSessionId || recoveringQueue) return
    const store = useAppStore.getState()
    const source = store.sessions.find((session) => session.id === currentSessionId)
    if (!source || store.currentWorkspace?.realPath !== source.cwd) {
      store.setSessionError(currentSessionId, 'chat.queueWorkspaceChanged')
      return
    }
    setRecoveringQueue(true)
    try {
      const readOnly = source.readonly || source.remoteReadonly || source.nativePermissionMode === 'no-bash'
      const target = await createSessionForCurrentProject(readOnly ? { permissionMode: 'readonly' } : undefined)
      if (!target || !useAppStore.getState().moveClosedQueue(source.id, target)) {
        store.setSessionError(source.id, 'chat.queueRecoveryFailed')
      }
    } catch {
      store.setSessionError(source.id, 'chat.queueRecoveryFailed')
    } finally {
      setRecoveringQueue(false)
    }
  }

  const handleCompact = useCallback(async () => {
    const sid = currentSessionId
    if (!sid) return
    const store = useAppStore.getState()
    store.setCompacting(sid, true)
    try {
      const ok = await window.electronAPI.compactSession(sid)
      if (!ok) {
        // Silent "nothing happened" reads as a dead button — say it failed.
        useAppStore.getState().setSessionError(sid, 'chat.compactFailed')
      }
    } catch {
      useAppStore.getState().setSessionError(sid, 'chat.compactFailed')
    } finally {
      useAppStore.getState().setCompacting(sid, false)
    }
    const stats = await window.electronAPI.getSessionStats(sid)
    if (stats) useAppStore.getState().setStats(sid, stats)
  }, [currentSessionId])

  const handleSelectProject = async () => {
    await selectWorkspace()
  }

  /**
   * 开分支：fork the CURRENT live conversation up to (and including) the
   * chosen turn into a new session. The durable transcript is Main's record;
   * a turn still streaming must not be branched (MessageList hides the
   * button) because its tail is not on disk yet.
   */
  const handleBranchTurn = useCallback(async (sessionId: string, keepUserTurns: number) => {
    const workspace = useAppStore.getState().currentWorkspace
    if (!workspace) return
    try {
      const result = await window.electronAPI.forkSession(workspace.id, { liveSessionId: sessionId, keepUserTurns })
      if (!result || 'error' in result) {
        showNotice('history.forkFailed')
        return
      }
      const { session, messages: restored, historicalAgents } = result
      useAppStore.getState().addSession(session, false)
      useAppStore.getState().setMessages(session.id, restored)
      useAppStore.getState().applyHistoricalAgents(session.id, historicalAgents ?? [])
      useAppStore.getState().setCurrentSessionId(session.id)
      navigate('/')
    } catch {
      showNotice('history.forkFailed')
    }
  }, [navigate])

  const openOfficeFile = async () => {
    const picked = await window.electronAPI.officeOpenDialog()
    if (!picked) return
    setWorkspacePanel({ kind: 'office', grant: picked.grant, name: picked.name })
  }

  const projectName = currentWorkspace ? basename(currentWorkspace.displayPath) || null : null
  const exportedFilename = exportSuccessPath ? exportFilename(exportSuccessPath) : null
  const showHero = sessionMessages.length === 0
  const showThinking =
    isBusy && sessionMessages.length > 0 && sessionMessages[sessionMessages.length - 1].role === 'user'

  return (
    <div ref={columnRef} className="relative flex h-full flex-col">
      {/* Keep a window drag region on home and show session controls in chat. */}
      {currentSessionId ? (
        <header className="app-drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 text-xs">
        {/* ZCode-style order: bold session title first, then context pills */}
        <span className="min-w-0 shrink truncate text-[13px] font-semibold tracking-tight text-cream">
          {sessionPreview ? sessionPreview.title : currentSession ? currentSession.title : t('chat.noActiveSession')}
        </span>
        {/* project pill: full path on hover; collapses to icon-only when the
            column is squeezed (browser panel open) */}
        {projectName && currentWorkspace && (
          <span
            title={currentWorkspace.displayPath}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-cream-faint"
          >
            <FolderOpen size={12} className="shrink-0 text-accent" />
            {!compact && <span className="max-w-[160px] truncate">{projectName}</span>}
          </span>
        )}
        {/* branch pill: always on for git workspaces; GitChip hides itself
            while loading and for non-git dirs. */}
        <GitChip trailing={<ChevronDown size={10} className="shrink-0 text-cream-faint" />} />
        {currentSession?.origin === 'feishu' && (
          <span
            className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] font-medium text-cream-faint"
            title={t('sidebar.feishuSession')}
          >
            {t('chat.feishuChip')}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-cream-dim">
          {currentWorkspace && <OpenWithMenu workspaceId={currentWorkspace.id} compact={compact} />}
          <button
            onClick={toggleWorkspace}
            aria-label={t('sidebar.workbench')}
            aria-pressed={Boolean(workspacePanel)}
            title={t('sidebar.workbench')}
            className={`focus-ring app-no-drag rounded-md p-1.5 transition-colors hover:bg-overlay hover:text-cream ${
              workspacePanel ? 'text-accent' : 'text-cream-faint'
            }`}
          >
            <PanelRight size={14} />
          </button>
          {currentSessionId && (
            <button
              onClick={() => void handleExport()}
              disabled={exporting}
              title={
                exporting
                  ? t('export.exporting')
                  : exportFailed
                    ? t('export.failed')
                    : exportSuccessPath
                      ? t('export.successWithFile', { filename: exportedFilename ?? '' })
                    : t('export.button')
              }
              aria-label={t('export.button')}
              className={`focus-ring app-no-drag rounded-md p-1.5 transition-colors hover:bg-overlay disabled:opacity-60 ${
                exportFailed
                  ? 'text-red-500'
                  : exportSuccessPath
                    ? 'text-emerald-500'
                    : 'text-cream-dim hover:text-cream'
              }`}
            >
              {exporting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
            </button>
          )}
          {exportSuccessPath && (
            <span
              className="max-w-[220px] truncate font-medium text-emerald-500"
              title={exportSuccessPath}
              aria-live="polite"
            >
              {t('export.successWithFile', { filename: exportedFilename ?? '' })}
            </span>
          )}
          {exportFailed && (
            <span className="font-medium text-red-500" aria-live="polite">
              {t('export.failed')}
            </span>
          )}
          {isCompacting && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              <span className="font-medium text-accent">{t('chat.compacting')}</span>
            </span>
          )}
          {isStopping ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              <span role="status" className="font-medium text-amber-500">{t('chat.stopping')}</span>
            </>
          ) : statusError ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              <span role="alert" className="font-medium text-red-500">{t(statusError)}</span>
            </>
          ) : isBusy ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              <span role="status" className="font-medium text-amber-500">{t('chat.running')}</span>
            </>
          ) : null}
        </span>
        </header>
      ) : (
        <div className="app-drag h-12 shrink-0" />
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleTranscriptScroll} className="relative h-full overflow-y-auto" style={{ overflowAnchor: 'none' }}>
        <div ref={contentRef} className="min-h-full">
        {showHero ? (
          <div className="agent-home flex min-h-full flex-col items-center">
            <div className="home-hero flex flex-col items-center">
              <h1 className="home-heading">{t('home.heading')}</h1>
              <div className="w-full">
                {!currentWorkspace && unavailableDefault && <div className="mb-3 rounded-xl border border-line px-2 py-2 text-xs text-cream-dim">
                  <p className="px-2.5 pb-1">{t('projects.defaultUnavailable')}</p>
                  <p className="break-all px-2.5 pb-2 text-[11px] text-cream-faint">{unavailableDefault.path}</p>
                  <ProjectRecovery project={unavailableDefault} />
                </div>}
                <Composer
                  onSend={handleSend}
                  onStop={handleStop}
                  busy={isBusy}
                  stopping={isStopping}
                  focusKey={currentSessionId}
                  disabled={cliAvailable === false || previewActive}
                  commands={slashCommands}
                  appCommands={appCommands}
                  onCompact={currentSessionId ? handleCompact : undefined}
                  compact={compact}
                />
                {sendError && <p role="alert" className="mt-2 text-center text-xs text-red-500">{t(sendError)}</p>}
                <div className="home-quick-links" aria-label={t('home.quickLabel')}>
                  <button type="button" className="focus-ring" onClick={() => setWorkspacePanel({ kind: 'browser' })}>
                    <Globe2 size={15} aria-hidden="true" />
                    <span>{t('home.quick.browser')}</span>
                  </button>
                  {/* One office entry: the "files" and "sheets" quick buttons used
                      to call the same dialog — the office panel is a workbook
                      editor, so the single button says sheets. */}
                  <button type="button" className="focus-ring" onClick={() => void openOfficeFile()}>
                    <Table2 size={15} aria-hidden="true" />
                    <span>{t('home.quick.sheets')}</span>
                  </button>
                  <button type="button" className="focus-ring" onClick={() => navigate('/tasks')}>
                    <Clock3 size={15} aria-hidden="true" />
                    <span>{t('home.quick.tasks')}</span>
                  </button>
                  <button type="button" className="focus-ring" onClick={() => navigate('/plugins')}>
                    <Layers size={15} aria-hidden="true" />
                    <span>{t('home.quick.plugins')}</span>
                  </button>
                </div>
                {!currentSessionId && <p className="home-keyboard-hint">{t('composer.hint')}</p>}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[760px]">
            <MessageList messages={sessionMessages} sessionId={currentSessionId} onRetry={handleRetry} onBranch={handleBranchTurn} />
            <ExecutionActivity sessionId={currentSessionId} />
            {showThinking && (
              <div className="msg-in flex items-center gap-1 px-6 pb-6">
                <span className="think-dot h-1.5 w-1.5 rounded-full bg-cream-dim" />
                <span className="think-dot h-1.5 w-1.5 rounded-full bg-cream-dim" />
                <span className="think-dot h-1.5 w-1.5 rounded-full bg-cream-dim" />
              </div>
            )}
          </div>
        )}
        {previewActive && (
          <div className="msg-in flex items-center gap-2 px-6 pb-2 text-[12px] text-cream-faint">
            {sessionPreview?.failed ? <CircleAlert size={13} className="text-amber-600" /> : <Loader2 size={13} className="animate-spin" />}
            {sessionPreview?.failed ? t('chat.previewFailed') : t('chat.previewRestoring')}
          </div>
        )}
        {creatingSession && (
          <div className="msg-in flex items-center gap-2 px-6 pb-6 text-[12px] text-cream-faint">
            <Loader2 size={13} className="animate-spin" />
            {t('chat.creatingSession')}
          </div>
        )}
        </div>
        </div>
        {showJump && (
          <button
            onClick={jumpToBottom}
            title={t('chat.jumpToBottom')}
            aria-label={t('chat.jumpToBottom')}
            className="focus-ring absolute bottom-4 right-5 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-line bg-ink-850 text-cream-dim shadow-card transition-colors hover:bg-overlay hover:text-cream"
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {!currentWorkspace && !showHero && (
        <div className="flex justify-center pb-1">
          <button
            onClick={handleSelectProject}
            className="flex items-center gap-2 rounded-full border border-line bg-ink-850 px-3.5 py-1.5 text-xs text-cream-dim shadow-card transition-all duration-200 ease-standard hover:-translate-y-px hover:border-line-strong hover:text-cream"
          >
            <FolderOpen size={12} />
            {t('chat.selectProject')}
          </button>
        </div>
      )}

      {!showHero && (
        <>
          {currentSessionId && queuedCount > 0 && queuePauseReason && (
            <div className="px-4 pb-1">
              <div className="mx-auto flex max-w-[760px] flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-overlay px-3 py-2 text-xs text-cream-dim">
                <span role="status">
                  {t(queuePauseReason === 'unknown' ? 'chat.queueUnknownHeld' : 'chat.queueHeld', { count: queuedCount })}
                </span>
                <button
                  type="button"
                  onClick={closedQueue ? recoverQueuedMessages : () => { useAppStore.getState().resumeQueuedMessages(currentSessionId) }}
                  disabled={isBusy || isStopping || Boolean(queueDispatching) || recoveringQueue}
                  className="focus-ring shrink-0 rounded-md border border-line px-2.5 py-1 text-cream transition-colors hover:bg-overlay-strong disabled:opacity-50"
                >
                  {t(closedQueue ? 'chat.queueRecover' : queuePauseReason === 'unknown' ? 'chat.queueRetryUnknown' : 'chat.queueResume')}
                </button>
              </div>
            </div>
          )}
          <Composer
            onSend={handleSend}
            onStop={handleStop}
            busy={isBusy}
            stopping={isStopping}
            focusKey={currentSessionId}
            disabled={cliAvailable === false || previewActive}
            commands={slashCommands}
            appCommands={appCommands}
            onCompact={currentSessionId ? handleCompact : undefined}
            compact={compact}
          />
        </>
      )}

      {pendingUi && currentSessionId && (
        <ExtensionUiDialog sessionId={currentSessionId} request={pendingUi} />
      )}
    </div>
  )
}
