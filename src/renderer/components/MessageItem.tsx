import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  Info,
  LayoutDashboard,
  Loader2,
  Pencil
} from 'lucide-react'
import { MessageLike, useAppStore } from '../store'
import { useT } from '../i18n'
import { formatSeconds } from '../lib/time'
import Markdown from './Markdown'
import { SaveMessageToBoardDialog } from './SaveMessageToBoardDialog'

interface MessageItemProps {
  message: MessageLike
  /** Index within the session's message array; -1 when unknown. */
  index?: number
  sessionId?: string | null
}

export default function MessageItem({ message, index = -1, sessionId = null }: MessageItemProps) {
  const [copied, setCopied] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [boardDialogOpen, setBoardDialogOpen] = useState(false)
  const [boardSaved, setBoardSaved] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const t = useT()
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const checkpointAvailable = useAppStore((s) =>
    sessionId ? s.checkpointUnavailable[sessionId] !== true : false
  )
  // Per-turn runtime snapshot, captured at dispatch time. Historical turns are
  // self-describing: this renders ONLY what the message itself recorded, never
  // the session's current model or the global default.
  const runtimeModel = message.runtimeModel
  const runtimeThinking = message.runtimeThinking
  // Legacy builds (no snapshot metadata) show nothing — we never fabricate
  // current/global model as a stand-in for a historical turn.
  const tagLabel = runtimeModel
    ? runtimeThinking
      ? `${runtimeModel} · ${runtimeThinking}`
      : runtimeModel
    : undefined

  // Thinking elapsed time: ticks once a second while the run streams.
  const thinkingStreaming = Boolean(message.thinking) && message.thinkingEndTs === undefined
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!thinkingStreaming) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [thinkingStreaming])
  const thinkingEnd = message.thinkingEndTs ?? (thinkingStreaming ? now : 0)
  const thinkingElapsed =
    message.thinking && message.thinkingStartTs && thinkingEnd
      ? formatSeconds(thinkingEnd - message.thinkingStartTs)
      : null

  const copyContent = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  // Prefill the composer with this message so it can be edited and resent;
  // the history entry stays untouched.
  const editContent = () => {
    useAppStore.getState().setComposerPrefill(message.content)
  }

  const runRollback = async () => {
    if (!sessionId || index < 0) return
    setRestoring(true)
    const store = useAppStore.getState()
    try {
      const checkpoints = await window.electronAPI.checkpointList(sessionId)
      const target = checkpoints
        .filter((c) => c.msgIndex <= index)
        .sort((a, b) => b.msgIndex - a.msgIndex)[0]
      if (!target) {
        store.addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: 'system',
          content: t('rollback.failed', { log: t('rollback.none') })
        })
        return
      }
      const result = await window.electronAPI.checkpointRestore(target.id)
      if (result.ok) {
        store.addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: 'system',
          variant: 'info',
          content: t('rollback.done')
        })
        // The worktree just changed underneath the changes tab / git chip.
        store.bumpGitInfoVersion()
      } else {
        store.addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: 'system',
          content: t('rollback.failed', { log: result.log })
        })
      }
    } finally {
      setRestoring(false)
    }
  }

  // Two-stage confirm, same pattern as the packages page uninstall button.
  const handleRollbackClick = () => {
    if (restoring) return
    if (!confirmRollback) {
      setConfirmRollback(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmRollback(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmRollback(false)
    void runRollback()
  }

  if (isUser) {
    const isSteer = message.kind === 'steer'
    return (
      <div
        className="msg-in group flex justify-end"
        aria-label={isSteer ? `${t('msg.steer')}: ${message.content}` : undefined}
      >
        <div className="relative max-w-[85%]">
          {isSteer && (
            <div className="mb-1 flex justify-end">
              <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-px text-[10px] font-medium uppercase tracking-wider text-accent">
                <ArrowRight size={10} />
                {t('msg.steer')}
              </span>
            </div>
          )}
          <div
            className={`whitespace-pre-wrap rounded-[18px] rounded-br-[6px] px-4 py-2.5 text-[14px] leading-[1.75] text-cream ${
              isSteer
                ? 'border border-accent/35 bg-accent/[0.12] shadow-[inset_3px_0_0_var(--accent)]'
                : 'bg-ink-700'
            }`}
          >
            {message.images && message.images.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {message.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt=""
                    className="h-14 w-14 rounded-lg border border-line object-cover"
                  />
                ))}
              </div>
            )}
            {message.content}
          </div>
          {message.failed && (
            <div className="mt-1 flex justify-end">
              <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-px text-[10px] font-medium text-red-500">
                {t('msg.sendFailed')}
              </span>
            </div>
          )}
          {/* hover action bar: per-turn model/thinking tag, copy, edit-and-resend */}
          <div className="mt-1 flex items-center justify-end gap-1 opacity-0 transition-all group-hover:opacity-100">
            {tagLabel && (
              <span
                title={t('composer.model')}
                className="rounded-full border border-line px-2 py-px text-[10.5px] text-cream-faint"
              >
                {tagLabel}
              </span>
            )}
            <button
              onClick={copyContent}
              title={t('msg.copy')}
              className="rounded-md p-1 text-cream-faint transition-all hover:bg-overlay hover:text-cream"
            >
              {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            </button>
            <button
              onClick={editContent}
              title={t('msg.edit')}
              className="rounded-md p-1 text-cream-faint transition-all hover:bg-overlay hover:text-cream"
            >
              <Pencil size={12} />
            </button>
          </div>
          <div className="absolute -left-7 top-1 flex flex-col gap-1">
            {checkpointAvailable && sessionId && index >= 0 && (
              <button
                onClick={handleRollbackClick}
                disabled={restoring}
                title={
                  restoring
                    ? t('rollback.restoring')
                    : confirmRollback
                      ? t('rollback.confirm')
                      : t('rollback.button')
                }
                className={`rounded-md p-1 transition-all disabled:opacity-60 ${
                  confirmRollback
                    ? 'bg-red-500/10 text-red-500 opacity-100'
                    : 'text-cream-faint opacity-0 hover:bg-overlay hover:text-cream group-hover:opacity-100'
                }`}
              >
                {restoring ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <History size={12} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  const isInfo = isSystem && message.variant === 'info'

  // System/info messages collapse to a small centered pill — no big boxes.
  if (isSystem) {
    return (
      <div className="msg-in flex justify-center">
        <div
          className={`flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[12px] leading-5 ${
            isInfo
              ? 'bg-overlay text-cream-dim'
              : 'bg-red-500/[0.08] text-red-600 dark:text-red-300'
          }`}
        >
          {isInfo ? (
            <Info size={11} className="shrink-0" />
          ) : (
            <AlertTriangle size={11} className="shrink-0" />
          )}
          <span className="min-w-0">{message.content}</span>
        </div>
      </div>
    )
  }

  // Assistant text spans the column edge to edge — no avatar, no bubble.
  return (
    <div className="msg-in group">
      {message.thinking && (
        <div className="mb-1.5">
          <button
            onClick={() => setThinkingOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-cream-faint transition-colors hover:bg-overlay hover:text-cream-dim"
          >
            <Brain size={12} className={thinkingStreaming ? 'animate-pulse text-accent' : ''} />
            <span>
              {t('msg.thinking')}
              {thinkingElapsed ? ` ${thinkingElapsed}s` : ''}
            </span>
            {thinkingOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {thinkingOpen && (
            <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-overlay px-3 py-2 font-mono text-[12px] leading-5 text-cream-dim">
              {message.thinking}
            </pre>
          )}
        </div>
      )}
      <Markdown content={message.content} />
      {message.content && (
        <div className="mt-1 flex items-center gap-1">
          <button
            onClick={copyContent}
            title={t('msg.copy')}
            className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[10.5px] text-cream-faint opacity-0 transition-all hover:bg-overlay hover:text-cream group-hover:opacity-100"
          >
            {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
            {copied ? t('msg.copied') : t('msg.copy')}
          </button>
          <button
            onClick={() => setBoardDialogOpen(true)}
            title={t('boards.chat.saveToBoard')}
            className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[10.5px] text-cream-faint transition hover:bg-overlay hover:text-cream"
          >
            <LayoutDashboard size={11} />
            {t('boards.chat.saveToBoard')}
          </button>
          {boardSaved && <span className="text-[10.5px] text-emerald-500">{t('boards.chat.saved')}</span>}
        </div>
      )}
      {boardDialogOpen && (
        <SaveMessageToBoardDialog
          content={message.content}
          onClose={() => setBoardDialogOpen(false)}
          onSaved={() => setBoardSaved(true)}
        />
      )}
    </div>
  )
}
