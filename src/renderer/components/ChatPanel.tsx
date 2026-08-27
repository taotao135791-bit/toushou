import { useRef, useEffect, useState } from 'react'
import { FolderOpen, Download, Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import { PromptImage, SlashCommand } from '@shared/types'
import { useAppStore } from '../store'
import { I18nKey, useT } from '../i18n'
import { createSessionForCurrentProject } from '../lib/session'
import { captureSessionSnapshot } from '../lib/runtimeSnapshot'
import { exportFilename } from '../lib/exportFilename'
import MessageList from './MessageList'
import ExecutionActivity from './ExecutionActivity'
import Composer from './Composer'
import ExtensionUiDialog from './ExtensionUiDialog'
import GitChip from './GitChip'
import Logo from './Logo'

export default function ChatPanel() {
  const {
    currentSessionId,
    currentWorkspace,
    sessions,
    messages,
    packages,
    cliAvailable,
    busy,
    uiRequests,
    selectWorkspace
  } = useAppStore()
  const t = useT()

  const currentSession = sessions.find((s) => s.id === currentSessionId)
  const sessionMessages = currentSessionId ? messages[currentSessionId] || [] : []
  const isBusy = currentSessionId ? Boolean(busy[currentSessionId]) : false
  const isCompacting = useAppStore((s) =>
    currentSessionId ? Boolean(s.compacting[currentSessionId]) : false
  )
  const pendingUi = currentSessionId ? (uiRequests[currentSessionId] || [])[0] : undefined
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
  const [exporting, setExporting] = useState(false)
  const [exportFailed, setExportFailed] = useState(false)
  const [exportSuccessPath, setExportSuccessPath] = useState<string | null>(null)
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Session-less send failure (create threw — e.g. a stale workspace grant)
  const [sendError, setSendError] = useState<I18nKey | null>(null)

  const isStopping = currentSessionId !== null && stoppingSessionId === currentSessionId

  // A terminal runtime event confirms Stop. Until then the local state gives
  // immediate feedback and prevents a second abort click.
  useEffect(() => {
    if (!stoppingSessionId || busy[stoppingSessionId]) return
    setStoppingSessionId(null)
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
  }, [busy, stoppingSessionId])

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

  const handleSend = async (text: string, images?: PromptImage[]): Promise<boolean> => {
    const trimmed = text.trim()
    if (!trimmed || cliAvailable === false) return false
    let sessionId = currentSessionId
    if (!sessionId) {
      // Session creation throws on an invalid grant — fail loudly and let the
      // composer restore the draft instead of losing it to a rejection.
      try {
        sessionId = await createSessionForCurrentProject()
      } catch (err) {
        console.error('Session creation failed:', err)
        setSendError('chat.createFailed')
        setTimeout(() => setSendError(null), 3000)
        return false
      }
    }
    if (!sessionId) return false
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
    // checkpoint really is the "before" state of this turn.
    const list = useAppStore.getState().messages[sessionId] || []
    await store.createCheckpointForMessage(sessionId, list.length - 1, trimmed)
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
  }

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

  const handleStop = async () => {
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
  }

  const handleCompact = async () => {
    const sid = currentSessionId
    if (!sid) return
    const store = useAppStore.getState()
    store.setCompacting(sid, true)
    await window.electronAPI.compactSession(sid)
    useAppStore.getState().setCompacting(sid, false)
    const stats = await window.electronAPI.getSessionStats(sid)
    if (stats) useAppStore.getState().setStats(sid, stats)
  }

  const handleSelectProject = async () => {
    await selectWorkspace()
  }

  const projectName = currentWorkspace ? currentWorkspace.displayPath.split('/').filter(Boolean).pop() : null
  const exportedFilename = exportSuccessPath ? exportFilename(exportSuccessPath) : null
  const enabledCount = packages.filter((p) => p.enabled).length
  const showHero = sessionMessages.length === 0
  const showThinking =
    isBusy && sessionMessages.length > 0 && sessionMessages[sessionMessages.length - 1].role === 'user'

  return (
    <div className="relative flex h-full flex-col">
      {/* status bar, doubles as window drag region */}
      <header className="app-drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 text-xs">
        {/* breadcrumb: project / branch / session title */}
        {projectName && (
          <>
            <span
              className="flex min-w-0 items-center gap-1.5 text-cream-dim"
              title={currentWorkspace?.displayPath ?? undefined}
            >
              <FolderOpen size={12} className="shrink-0" />
              <span className="max-w-[160px] truncate text-[12px] font-medium">{projectName}</span>
            </span>
            <ChevronRight size={10} className="shrink-0 text-cream-faint" />
          </>
        )}
        <GitChip trailing={<ChevronRight size={10} className="shrink-0 text-cream-faint" />} />
        <span className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-cream">
          {currentSession ? currentSession.title : t('chat.noActiveSession')}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-cream-dim">
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
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/80" />
              {t('chat.modulesActive', { count: enabledCount })}
            </>
          )}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleTranscriptScroll} className="relative h-full overflow-y-auto">
        {showHero ? (
          // Hero and composer form ONE centered block: mark, serif title,
          // composer — nothing else.
          <div className="flex h-full flex-col items-center px-8">
            <div className="my-auto flex w-full max-w-[680px] flex-col items-center pb-[10vh] pt-6">
              <div className="rise" style={{ animationDelay: '0ms' }}>
                <Logo size={52} />
              </div>
              <h2
                className="rise mb-10 mt-6 font-serif text-[27px] font-medium tracking-[0.01em] text-cream"
                style={{ animationDelay: '60ms' }}
              >
                {t('chat.hero.title')}
              </h2>
              <div className="rise w-full" style={{ animationDelay: '140ms' }}>
                {!currentWorkspace && (
                  <div className="mb-2 flex justify-center">
                    <button
                      onClick={handleSelectProject}
                      className="flex items-center gap-2 rounded-full border border-line bg-ink-850 px-3.5 py-1.5 text-xs text-cream-dim shadow-card transition-all duration-200 ease-standard hover:-translate-y-px hover:border-line-strong hover:text-cream"
                    >
                      <FolderOpen size={12} />
                      {t('chat.selectProject')}
                    </button>
                  </div>
                )}
                <Composer
                  onSend={handleSend}
                  onStop={handleStop}
                  busy={isBusy}
                  stopping={isStopping}
                  focusKey={currentSessionId}
                  disabled={cliAvailable === false}
                  commands={slashCommands}
                  onCompact={currentSessionId ? handleCompact : undefined}
                />
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
        <Composer
          onSend={handleSend}
          onStop={handleStop}
          busy={isBusy}
          stopping={isStopping}
          focusKey={currentSessionId}
          disabled={cliAvailable === false}
          commands={slashCommands}
          onCompact={currentSessionId ? handleCompact : undefined}
        />
      )}

      {pendingUi && currentSessionId && (
        <ExtensionUiDialog sessionId={currentSessionId} request={pendingUi} />
      )}
    </div>
  )
}
