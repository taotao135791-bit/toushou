import BoardsIcon from './BoardsIcon'
import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FolderOpen,
  SquarePen,
  Loader2,
  ChevronDown,
  PanelRight,
  ScrollText,
  X,
  Clock3,
  Layers,
  Link2,
  BookOpen,
  SlidersHorizontal,
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
import RunningTurnProgress from './RunningTurnProgress'
import { finishHistoryResume } from '../lib/historyResume'
import { beginNavigationIntent, isCurrentNavigationIntent } from '../lib/navigationIntent'

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
  const sessionInstruction = useAppStore((s) => currentSessionId ? s.sessionInstructions[currentSessionId] : undefined)
  const setSessionInstructions = useAppStore((s) => s.setSessionInstructions)
  /** 会话设定编辑弹窗（学 kimi 的会话设定：手写长期指令）。 */
  const [instructionOpen, setInstructionOpen] = useState(false)
  const [instructionDraft, setInstructionDraft] = useState('')
  const { viewportRef: scrollRef, contentRef, onScroll: handleTranscriptScroll, showJump, jumpToBottom } = useTranscriptScroll(currentSessionId)
  const [commandResult, setCommandResult] = useState<{ sessionId: string; commands: SlashCommand[] } | null>(null)
  const slashCommands = commandResult?.sessionId === currentSessionId ? commandResult.commands : undefined
  const navigate = useNavigate()
  // Built-in slash commands: available in the palette everywhere (home and
  // chat) — app commands must not depend on a live session. Deps are stable
  // across streaming renders, so the memoized Composer's props hold.
  const appCommands = useMemo(
    () => [
      {
        name: 'new',
        description: t('slash.new'),
        icon: SquarePen,
        run: () => useAppStore.getState().setCurrentSessionId(null)
      },
      { name: 'mcp', description: t('slash.mcp'), icon: Link2, run: () => navigate('/connections') },
      {
        name: 'tiktok',
        description: t('slash.tiktok'),
        icon: BarChart3,
        run: () => useAppStore.getState().setComposerPrefill(t('slash.tiktokPrompt'))
      },
      { name: 'tasks', description: t('slash.tasks'), icon: Clock3, run: () => navigate('/tasks') },
      { name: 'boards', description: t('slash.boards'), icon: BoardsIcon, run: () => navigate('/boards') },
      { name: 'skills', description: t('slash.skills'), icon: BookOpen, run: () => navigate('/skills') },
      { name: 'plugins', description: t('slash.plugins'), icon: Layers, run: () => navigate('/plugins') },
      { name: 'settings', description: t('slash.settings'), icon: SlidersHorizontal, run: () => navigate('/settings') }
    ],
    [t, navigate]
  )
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null)
  const [recoveringQueue, setRecoveringQueue] = useState(false)
  const preparingPrompts = useRef(new Map<string, string>())
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stoppingBusy = useAppStore((s) =>
    stoppingSessionId ? Boolean(s.busy[stoppingSessionId] || s.compacting[stoppingSessionId]) : false
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
    if (!currentSessionId) return
    let cancelled = false
    window.electronAPI.listCommands(currentSessionId).then((cmds) => {
      if (!cancelled) setCommandResult({ sessionId: currentSessionId, commands: cmds })
    }).catch(() => undefined)
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
    async (text: string, images?: PromptImage[], onTarget?: (sessionId: string) => void): Promise<boolean> => {
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
      onTarget?.(sessionId)
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
      if (!liveSession?.draftSessionUuid || liveSession.resumeFrom || liveSession.resumedHistoryId) {
        void store.refreshComposerDraftIdentity(sessionId)
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
        if (current.busy[sid] || current.compacting[sid]) {
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
    if (store.busy[sid] || store.compacting[sid] || sid.startsWith('preview:')) return
    store.setSessionError(sid, null)
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
  }, [currentSessionId])

  const handleSelectProject = async () => {
    await selectWorkspace()
  }

  const forkCurrentSession = useCallback(async (sessionId: string, message: MessageLike) => {
    const state = useAppStore.getState()
    const workspace = state.currentWorkspace
    if (!workspace || state.currentSessionId !== sessionId || !message.replyKey) return
    const matches = state.messages[sessionId]?.filter(row => row.replyKey === message.replyKey) ?? []
    const occurrence = matches.findIndex(row => row.id === message.id) + 1
    if (!occurrence) return
    const reply = { key: message.replyKey, occurrence, total: matches.length }
    const source = sessionId.startsWith('preview:') ? { historyId: sessionId.slice('preview:'.length) } : { liveSessionId: sessionId }
    const intent = beginNavigationIntent()
    try {
      const result = await window.electronAPI.forkSession(workspace.id, { ...source, reply })
      if (!result || 'error' in result) {
        if (isCurrentNavigationIntent(intent)) showNotice('history.branchFailed')
        return
      }
      const { session, messages: restored, historicalAgents } = result
      const store = useAppStore.getState()
      finishHistoryResume(workspace, {
        save: () => {
          store.addSession(session, false)
          store.setMessages(session.id, restored)
          store.applyHistoricalAgents(session.id, historicalAgents ?? [])
        },
        currentWorkspace: () => isCurrentNavigationIntent(intent) ? useAppStore.getState().currentWorkspace : null,
        select: () => {
          store.setCurrentSessionId(session.id, intent)
          navigate('/')
        }
      })
    } catch {
      if (isCurrentNavigationIntent(intent)) showNotice('history.branchFailed')
    }
  }, [navigate])

  const openOfficeFile = async () => {
    const picked = await window.electronAPI.officeOpenDialog()
    if (!picked) return
    setWorkspacePanel({ kind: 'office', grant: picked.grant, name: picked.name })
  }

  const projectName = currentWorkspace ? basename(currentWorkspace.displayPath) || null : null
  // 转写装载中不渲染 home hero（学 dsh/kimi：切换期间不经过空状态）。
  const transcriptHydrating = useAppStore((s) => currentSessionId ? Boolean(s.transcriptHydrating[currentSessionId]) : false)
  const showHero = sessionMessages.length === 0 && !transcriptHydrating
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
          {currentSessionId && (
            <button
              onClick={() => { setInstructionDraft(sessionInstruction ?? ''); setInstructionOpen(true) }}
              aria-label={t('chat.instruction.open')}
              title={sessionInstruction ? t('chat.instruction.hasOne') : t('chat.instruction.open')}
              className={`focus-ring app-no-drag rounded-md p-1.5 transition-colors hover:bg-overlay hover:text-cream ${
                sessionInstruction ? 'text-accent' : 'text-cream-faint'
              }`}
            >
              <ScrollText size={14} />
            </button>
          )}
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
          {isCompacting && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              <span className="font-medium text-accent">{t('chat.compacting')}</span>
              {!isBusy && <button type="button" onClick={handleStop} disabled={isStopping}
                className="app-no-drag focus-ring rounded px-1 hover:text-cream disabled:opacity-50">{t('common.cancel')}</button>}
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

      {instructionOpen && currentSessionId && (
        <div className="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div role="dialog" aria-modal="true" aria-label={t('chat.instruction.open')}
            className="dialog-panel w-full max-w-[560px] rounded-2xl border border-line bg-ink-850 p-4 shadow-pop">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[13px] font-medium text-cream">{t('chat.instruction.title')}</h3>
              <button onClick={() => setInstructionOpen(false)} aria-label={t('common.cancel')}
                className="focus-ring rounded-md p-1 text-cream-faint hover:bg-overlay hover:text-cream"><X size={14} /></button>
            </div>
            <p className="mb-2 text-[11.5px] leading-4 text-cream-faint">{t('chat.instruction.hint')}</p>
            <textarea
              value={instructionDraft}
              onChange={(e) => setInstructionDraft(e.target.value)}
              rows={6}
              placeholder={t('chat.instruction.placeholder')}
              className="w-full resize-none rounded-lg border border-line bg-ink-900 px-2.5 py-2 text-[12.5px] leading-5 text-cream placeholder-cream-faint outline-none focus:border-accent/40"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              {sessionInstruction && (
                <button
                  onClick={() => { setInstructionDraft(''); setSessionInstructions(currentSessionId, '') }}
                  className="focus-ring rounded-lg border border-line px-2.5 py-1 text-[12px] text-cream-dim transition-colors hover:bg-overlay hover:text-cream"
                >
                  {t('chat.instruction.clear')}
                </button>
              )}
              <button
                onClick={() => {
                  const text = instructionDraft.trim()
                  if (!text) return
                  setSessionInstructions(currentSessionId, text)
                  setInstructionOpen(false)
                  // 设定作为一条正式消息发送：立即生效、写入会话历史
                  // （resume 后模型依然可见），并复用排队/转向兼容链路。
                  void handleSend(`【会话设定】此后所有回复遵守以下要求：\n${text}\n（本条为设定同步消息，无需逐条复述。）`)
                }}
                disabled={!instructionDraft.trim()}
                title={t('chat.instruction.apply')}
                className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-[rgb(var(--bg-app))] transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:bg-overlay-strong disabled:text-cream-faint"
              >
                {t('chat.instruction.apply')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleTranscriptScroll} className="relative h-full overflow-y-auto" style={{ overflowAnchor: 'none' }}>
        <div ref={contentRef} className="min-h-full">
        {showHero ? (
          <div className="agent-home flex min-h-full flex-col items-center">
            <div className="home-hero flex flex-col items-center">
              <h1 className="home-heading">{t('home.heading')}</h1>              <div className="w-full">
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
                  disabled={cliAvailable === false || previewActive || isCompacting}
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
            <MessageList messages={sessionMessages} sessionId={currentSessionId} onRetry={handleRetry} onBranch={forkCurrentSession} />
            {transcriptHydrating && (
              <div className="msg-in flex items-center gap-2 px-6 pb-2 text-[12px] text-cream-faint">
                <Loader2 size={13} className="animate-spin" />
                {t('chat.loadingTranscript')}
              </div>
            )}
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
          {isBusy && currentSessionId && <RunningTurnProgress key={currentSessionId} sessionId={currentSessionId} waiting={Boolean(pendingUi)} stopping={isStopping} compacting={isCompacting} />}
          <Composer
            onSend={handleSend}
            onStop={handleStop}
            busy={isBusy}
            stopping={isStopping}
            focusKey={currentSessionId}
            disabled={cliAvailable === false || previewActive || isCompacting}
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
