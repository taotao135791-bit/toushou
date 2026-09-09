import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Download,
  Loader2,
  ChevronDown,
  PanelRight,
  LayoutDashboard,
  CalendarClock,
  Plug,
  BookOpen,
  Puzzle,
  Settings2
} from 'lucide-react'
import { PromptImage, SlashCommand } from '@shared/types'
import { MessageLike, UiRequest, useAppStore } from '../store'
import { I18nKey, useT } from '../i18n'
import { createSessionForCurrentProject } from '../lib/session'
import { captureSessionSnapshot } from '../lib/runtimeSnapshot'
import { exportFilename } from '../lib/exportFilename'
import { basename } from '../lib/path'
import MessageList from './MessageList'
import ExecutionActivity from './ExecutionActivity'
import Composer from './Composer'
import ExtensionUiDialog from './ExtensionUiDialog'
import GitChip from './GitChip'
import OpenWithMenu from './OpenWithMenu'
import Logo from './Logo'
import useElementWidth from '../lib/useElementWidth'

const EMPTY_MESSAGES: MessageLike[] = []
const EMPTY_UI_REQUESTS: UiRequest[] = []

/** Below this chat-column width the header/toolbar collapse to icon-only. */
const COMPACT_BREAKPOINT = 760


export default function ChatPanel() {
  const t = useT()
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const sessions = useAppStore((s) => s.sessions)
  const cliAvailable = useAppStore((s) => s.cliAvailable)
  const workspacePanel = useAppStore((s) => s.workspacePanel)
  const setWorkspacePanel = useAppStore((s) => s.setWorkspacePanel)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const createProjectWorkspace = useAppStore((s) => s.createProjectWorkspace)
  const selectDefaultWorkspace = useAppStore((s) => s.selectDefaultWorkspace)
  // Per-session slices only: streaming deltas of OTHER sessions must not
  // re-render this chat, and unrelated store writes must not either.
  const sessionMessages = useAppStore((s) =>
    currentSessionId ? s.messages[currentSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  )
  const isBusy = useAppStore((s) =>
    currentSessionId ? Boolean(s.busy[currentSessionId]) : false
  )

  const currentSession = sessions.find((s) => s.id === currentSessionId)
  const isCompacting = useAppStore((s) =>
    currentSessionId ? Boolean(s.compacting[currentSessionId]) : false
  )
  const pendingUi = useAppStore((s) =>
    currentSessionId ? (s.uiRequests[currentSessionId] ?? EMPTY_UI_REQUESTS)[0] : undefined
  )
  const sessionError = useAppStore((s) =>
    currentSessionId ? s.sessionErrors[currentSessionId] : undefined
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  // Only auto-scroll while the user is pinned to the bottom; scrolling up
  // during streaming must not yank the view back down on every delta.
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  // Suppress the scroll handler while a programmatic jump animates — the
  // intermediate positions would otherwise flip pinned off mid-flight.
  const jumpingRef = useRef(false)
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
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stoppingBusy = useAppStore((s) =>
    stoppingSessionId ? Boolean(s.busy[stoppingSessionId]) : false
  )
  // Session-less send failure (create threw — e.g. a stale workspace grant)
  const [sendError, setSendError] = useState<I18nKey | null>(null)
  // Home hero: inline "new project folder" naming state
  const [namingProject, setNamingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)
  const [projectCreateFailed, setProjectCreateFailed] = useState(false)

  const isStopping = currentSessionId !== null && stoppingSessionId === currentSessionId

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

  // This WebView ignores behavior:'smooth' (scrollTo/scrollIntoView no-op),
  // and rAF is throttled for occluded windows — so bottom-scroll is an
  // instant scrollTop write. Reliability over animation.
  const scrollToBottomNow = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useEffect(() => {
    if (pinnedRef.current) scrollToBottomNow()
  }, [sessionMessages, isBusy])

  const handleTranscriptScroll = () => {
    if (jumpingRef.current) return
    const el = scrollRef.current
    if (!el) return
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    pinnedRef.current = pinned
    setShowJump(!pinned)
  }

  const jumpToBottom = () => {
    pinnedRef.current = true
    setShowJump(false)
    jumpingRef.current = true
    scrollToBottomNow()
    // Recompute once the animation settles; if the stream is still appending,
    // the pinned effect above keeps the view glued to the bottom meanwhile.
    setTimeout(() => {
      jumpingRef.current = false
      handleTranscriptScroll()
    }, 500)
  }

  // useCallback-stabilized: Composer is memoized, so identity-stable handlers
  // are what let the input surface skip streaming re-renders entirely.
  const handleSend = useCallback(
    async (text: string, images?: PromptImage[]): Promise<boolean> => {
      const trimmed = text.trim()
      if (!trimmed || cliAvailable === false) return false
      let sessionId = currentSessionId
      if (!sessionId) {
        try {
          sessionId = await createSessionForCurrentProject()
        } catch (err) {
          // Session creation throws on an invalid grant — fail loudly and let
          // the composer restore the draft instead of losing it to a rejection.
          console.error('Session creation failed:', err)
          setSendError('chat.createFailed')
          setTimeout(() => setSendError(null), 3000)
          return false
        }
        if (!sessionId) {
          // No workspace could be resolved (default workspace creation failed).
          setSendError('chat.createFailed')
          setTimeout(() => setSendError(null), 3000)
          return false
        }
      }
      const store = useAppStore.getState()
      store.setSessionError(sessionId, null)
      // The user bubble lands immediately; the runtime snapshot below (a
      // get_state RPC with an 8s timeout on a hung session) resolves
      // concurrently and tags the message whenever it comes back.
      const snapshot = captureSessionSnapshot(sessionId)
      const messageId = crypto.randomUUID()
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
      // Optimistic: show the working state until agent_end / error lands
      store.setBusy(sessionId, true)
      const sent = await window.electronAPI.sendMessage(sessionId, trimmed, images)
      if (!sent) {
        // The session's process is gone: never leave "Running" on and never
        // drain the parked queue into the void — flag the failure instead.
        store.setBusy(sessionId, false)
        store.clearQueuedMessages(sessionId)
        store.setSessionError(sessionId, 'chat.sendFailed')
        store.updateMessage(sessionId, messageId, { failed: true })
        return false
      }
      // Tag the turn with the ACTUAL dispatch-time model/thinking — the
      // historical turn keeps what it ran under, never later session state.
      void snapshot.then((snap) => {
        useAppStore.getState().updateMessage(sessionId, messageId, {
          runtimeModel: snap.modelSelector,
          runtimeThinking: snap.thinkingLevel
        })
      })
      // First user message of an untitled session becomes its name
      void store.maybeNameSession(sessionId, trimmed)
      return true
    },
    [currentSessionId, cliAvailable]
  )

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
    const queuedCount = (store.queuedMessages[sid] || []).length
    setStoppingSessionId(sid)
    // Stop means stop: clear parked work before the terminal idle event can
    // drain it, and tell the user what happened.
    store.clearQueuedMessages(sid)
    if (queuedCount > 0) {
      store.addMessage(sid, {
        id: crypto.randomUUID(),
        role: 'system',
        variant: 'info',
        content: t('chat.queueCleared', { count: queuedCount })
      })
    }
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
  }, [t, currentSessionId, stoppingSessionId])

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

  const handleCreateProject = async () => {
    const name = newProjectName.trim()
    if (!name || creatingProject) return
    setCreatingProject(true)
    setProjectCreateFailed(false)
    const ok = await createProjectWorkspace(name)
    setCreatingProject(false)
    if (!ok) {
      setProjectCreateFailed(true)
      setTimeout(() => setProjectCreateFailed(false), 3000)
      return
    }
    setNamingProject(false)
    setNewProjectName('')
  }

  const projectName = currentWorkspace ? basename(currentWorkspace.displayPath) || null : null
  const exportedFilename = exportSuccessPath ? exportFilename(exportSuccessPath) : null
  const showHero = sessionMessages.length === 0
  const showThinking =
    isBusy && sessionMessages.length > 0 && sessionMessages[sessionMessages.length - 1].role === 'user'

  return (
    <div ref={columnRef} className="relative flex h-full flex-col">
      {/* Status bar, doubles as window drag region. On the home screen (no
          active session) it collapses to a bare drag spacer: breadcrumb,
          title, and every button need a session, and the premium home keeps a
          clean top edge. Chat keeps the full bar. */}
      {currentSessionId ? (
        <header className="app-drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 text-xs">
        {/* ZCode-style order: bold session title first, then context pills */}
        <span className="min-w-0 shrink truncate text-[13px] font-semibold tracking-tight text-cream">
          {currentSession ? currentSession.title : t('chat.noActiveSession')}
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
            飞书
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-cream-dim">
          {currentWorkspace && <OpenWithMenu workspaceId={currentWorkspace.id} compact={compact} />}
          <button
            onClick={toggleWorkspace}
            aria-label={t('sidebar.workbench')}
            aria-pressed={Boolean(workspacePanel)}
            title={t('sidebar.workbench')}
            className={`app-no-drag rounded-md p-1.5 transition hover:bg-overlay hover:text-cream ${
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
              className={`app-no-drag rounded-md p-1.5 transition hover:bg-overlay disabled:opacity-60 ${
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
              <span className="font-medium text-amber-500">{t('chat.stopping')}</span>
            </>
          ) : isBusy ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              <span className="font-medium text-amber-500">{t('chat.running')}</span>
            </>
          ) : sessionError ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              <span className="font-medium text-red-500">{t(sessionError)}</span>
            </>
          ) : sendError ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              <span className="font-medium text-red-500">{t(sendError)}</span>
            </>
          ) : null}
        </span>
        </header>
      ) : (
        <div className="app-drag h-12 shrink-0" />
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleTranscriptScroll} className="relative h-full overflow-y-auto">
        {showHero ? (
          // Hero and composer form ONE centered block: mark, serif hero
          // title, composer, then one faint hint line and the scenario chips
          // below — nothing else. The top bar is a bare drag spacer on home.
          <div className="flex min-h-full flex-col items-center px-8">
            <div className="my-auto flex w-full max-w-[680px] flex-col items-center pb-[10vh] pt-6">
              <div className="rise" style={{ animationDelay: '0ms' }}>
                <Logo size={52} />
              </div>
              <h2
                className="rise mb-10 mt-8 text-[32px] font-semibold tracking-tight text-cream"
                style={{ animationDelay: '60ms' }}
              >
                {t('chat.hero.title')}
              </h2>
              <div className="rise w-full" style={{ animationDelay: '140ms' }}>
                <Composer
                  onSend={handleSend}
                  onStop={handleStop}
                  busy={isBusy}
                  stopping={isStopping}
                  focusKey={currentSessionId}
                  disabled={cliAvailable === false}
                  commands={slashCommands}
                  appCommands={appCommands}
                  onCompact={currentSessionId ? handleCompact : undefined}
                  compact={compact}
                />
                {/* Home hint line: the @ / command / Enter affordances moved
                    here out of the placeholder — one faint centered line. */}
                {!currentSessionId && (
                  <p className="mt-1.5 text-center text-[11px] text-cream-faint/70">
                    {t('composer.hint')}
                  </p>
                )}
                {/* Scenario chips sit BELOW the composer (Kimi/ZCode home
                    pattern): a single centered row of ghost pills. The inline
                    "new project folder" naming row swaps into this slot. */}
                {!currentWorkspace && (
                  <div className="mt-4 flex flex-col items-center gap-2">
                    {namingProject ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          autoFocus
                          value={newProjectName}
                          onChange={(e) => setNewProjectName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleCreateProject()
                            if (e.key === 'Escape') {
                              setNamingProject(false)
                              setNewProjectName('')
                            }
                          }}
                          placeholder={t('home.namePlaceholder')}
                          className="h-8 w-52 rounded-full border border-line bg-ink-850 px-3.5 text-xs text-cream placeholder-cream-faint outline-none transition-colors focus:border-accent/50"
                        />
                        <button
                          onClick={() => void handleCreateProject()}
                          disabled={!newProjectName.trim() || creatingProject}
                          className="flex h-8 items-center gap-1.5 rounded-full bg-cream px-3.5 text-xs font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
                        >
                          {creatingProject ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <FolderPlus size={11} />
                          )}
                          {t('home.create')}
                        </button>
                        <button
                          onClick={() => {
                            setNamingProject(false)
                            setNewProjectName('')
                          }}
                          className="flex h-8 items-center rounded-full border border-line px-3 text-xs text-cream-dim transition hover:border-line-strong hover:text-cream"
                        >
                          {t('home.cancel')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        {([
                          { icon: FolderPlus, label: t('home.action.newFolder'), onClick: () => setNamingProject(true) },
                          { icon: FolderOpen, label: t('home.action.pickFolder'), onClick: () => void handleSelectProject() },
                          { icon: MessageSquare, label: t('home.action.noProject'), onClick: () => void selectDefaultWorkspace() }
                        ] as const).map(({ icon: Icon, label, onClick }) => (
                          <button
                            key={label}
                            onClick={onClick}
                            title={
                              label === t('home.action.noProject')
                                ? t('home.noProjectHint')
                                : undefined
                            }
                            className="flex max-w-[240px] items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-xs text-cream-faint transition-colors duration-200 ease-standard hover:bg-overlay hover:text-cream"
                          >
                            <Icon size={12} className="shrink-0" />
                            <span className="truncate">{label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {projectCreateFailed && (
                      <p className="text-[11px] text-red-500" aria-live="polite">
                        {t('home.createFailed')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[760px]">
            <MessageList messages={sessionMessages} sessionId={currentSessionId} />
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
        </div>
        {showJump && (
          <button
            onClick={jumpToBottom}
            title={t('chat.jumpToBottom')}
            className="absolute bottom-4 right-5 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-line bg-ink-850 text-cream-dim shadow-pop transition-all hover:text-cream"
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
          <Composer
            onSend={handleSend}
            onStop={handleStop}
            busy={isBusy}
            stopping={isStopping}
            focusKey={currentSessionId}
            disabled={cliAvailable === false}
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
