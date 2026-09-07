import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, FileDiff, Loader2, Redo2, Undo2 } from 'lucide-react'
import { CheckpointDiff, CheckpointDiffFile } from '@shared/types'
import { MessageLike, useAppStore } from '../store'
import { TurnActivity, TurnSummary, TurnVerb } from '../lib/execution'
import { I18nKey, useT } from '../i18n'
import { formatSeconds } from '../lib/time'
import { useConfirm } from '../lib/confirmClick'
import ToolCallCard from './ToolCallCard'

const VERB_KEYS: Record<TurnVerb, I18nKey> = {
  read: 'turn.verb.read',
  search: 'turn.verb.search',
  run: 'turn.verb.run',
  edit: 'turn.verb.edit',
  plan: 'turn.verb.plan',
  call: 'turn.verb.call'
}

/**
 * Live progress line above the streaming tool group: spinner, the current
 * action ("正在读取 src/x.ts"), then the counters collected so far this turn.
 */
export function LiveTurnRow({ activity }: { activity: TurnActivity }) {
  const t = useT()
  const segments: string[] = []
  if (activity.counts.filesRead > 0) segments.push(t('turn.count.read', { count: activity.counts.filesRead }))
  if (activity.counts.searches > 0) segments.push(t('turn.count.search', { count: activity.counts.searches }))
  if (activity.counts.commands > 0) segments.push(t('turn.count.run', { count: activity.counts.commands }))
  if (activity.counts.edits > 0) segments.push(t('turn.count.edit', { count: activity.counts.edits }))
  if (activity.counts.toolCalls > 0) segments.push(t('turn.count.tools', { count: activity.counts.toolCalls }))
  return (
    <div className="flex h-8 items-center gap-2 px-1 text-[12px] text-cream-faint">
      <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
      {activity.lastAction && (
        <span className="min-w-0 truncate">
          {t('turn.doing', { verb: t(VERB_KEYS[activity.lastAction.verb]) })}{' '}
          <span className="font-mono text-accent">{activity.lastAction.target}</span>
        </span>
      )}
      {segments.length > 0 && (
        <span className="shrink-0">· {segments.join(' · ')}</span>
      )}
    </div>
  )
}

interface ToolGroupProps {
  /** Consecutive tool-call messages collapsed into one bordered group. */
  run: MessageLike[]
  /** This group's turn is streaming: it stays expanded, the live row shows. */
  streaming: boolean
  /** Live counters — passed only to the current turn's last group. */
  activity?: TurnActivity
  /** Frozen summary of the last finished turn — same targeting as activity. */
  summary?: TurnSummary
}

/**
 * One bordered group of consecutive tool calls. Every step renders as its own
 * one-line row by default (ZCode/豆包-style step stream) — steps are the
 * story of what the agent did, so they are never hidden behind a counter.
 * While the turn streams a live progress row sits on top; when it finishes a
 * muted elapsed caption closes the group.
 */
export const ToolGroup = memo(function ToolGroup({ run, streaming, activity, summary }: ToolGroupProps) {
  const t = useT()
  const live = streaming && activity
  return (
    <div>
      {live && <LiveTurnRow activity={activity} />}
      <div className="msg-in overflow-hidden rounded-xl border border-line bg-ink-850/50">
        <div className="divide-y divide-line">
          {run.map((m) => (
            <ToolCallCard key={m.id} toolCall={m.toolCall!} />
          ))}
        </div>
      </div>
      {!streaming && summary && (
        <div className="px-1 pt-1 text-[11px] text-cream-faint/70">
          {t('turn.summary.elapsed', { s: formatSeconds(summary.elapsedMs) })}
        </div>
      )}
    </div>
  )
}, areToolGroupsEqual)

/**
 * MessageList rebuilds every `run` array on each streaming delta, so shallow
 * prop equality would always fail. A group is unchanged when every member
 * message kept its identity (message objects are immutable and stable until
 * patched by a tool result), and streaming/activity/summary are unchanged.
 * This keeps historical tool groups from re-rendering on each delta while
 * the live turn's last group still follows the stream.
 */
function areToolGroupsEqual(prev: ToolGroupProps, next: ToolGroupProps): boolean {
  if (prev.streaming !== next.streaming) return false
  if (prev.activity !== next.activity || prev.summary !== next.summary) return false
  if (prev.run === next.run) return true
  if (prev.run.length !== next.run.length) return false
  for (let i = 0; i < prev.run.length; i += 1) {
    if (prev.run[i] !== next.run[i]) return false
  }
  return true
}

const FILE_STATUS_LETTER: Record<CheckpointDiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D'
}

const FILE_STATUS_CLASS: Record<CheckpointDiffFile['status'], string> = {
  added: 'text-emerald-500',
  modified: 'text-amber-500',
  deleted: 'text-red-500'
}

interface TurnChangesRowProps {
  /** Restore failure feedback lands here as a system message. */
  sessionId: string | null
  /** The checkpoint minted before this turn dispatched. */
  checkpointId: string
}

/** What the change row renders for a finished turn. */
export type TurnChangesPhase = 'hidden' | 'normal' | 'undone'

/**
 * Pure render decision for the per-turn change row (unit-tested). A linked
 * pre-undo checkpoint means the turn is currently UNDONE — the row shows the
 * restored pill plus 重做, and that wins over a stale in-flight diff so the
 * flip is immediate after an undo. Otherwise the row is the plain change chip
 * when the diff has files, and hidden when there is nothing to show (nothing
 * changed since the checkpoint / non-git project / snapshot unavailable).
 */
export function turnChangesPhase(diff: CheckpointDiff | null, hasPreUndo: boolean): TurnChangesPhase {
  if (hasPreUndo) return 'undone'
  if (diff && diff.files.length > 0) return 'normal'
  return 'hidden'
}

/**
 * ZCode-style per-turn change row: a slim "已更改 N 个文件" chip that pins to
 * the END of a finished turn (mounted by MessageList only once the turn is
 * closed, so the lazy diff fetch fires exactly once per turn — never per
 * streaming delta). Expanding lists the files; 撤销 restores the project to
 * the checkpoint taken before the turn — reversibly: Main snapshots the
 * worktree first, the row flips to an "已恢复到本轮之前 + 重做" state, and
 * 重做 restores that snapshot via the same IPC, so a misclick never destroys
 * the agent's work. Hidden entirely when nothing differs or the diff is
 * unavailable (non-git projects never get checkpoints).
 */
export const TurnChangesRow = memo(function TurnChangesRow({
  sessionId,
  checkpointId
}: TurnChangesRowProps) {
  const t = useT()
  const [diff, setDiff] = useState<CheckpointDiff | null>(null)
  const [open, setOpen] = useState(false)
  /** In-flight restore, if any; gates both buttons against double clicks. */
  const [busy, setBusy] = useState<'undo' | 'redo' | null>(null)
  /** Brief confirmation for the legacy no-redo fallback path only. */
  const [flashRestored, setFlashRestored] = useState(false)
  // Redo target for this turn's last undo — Main mints one per restore and
  // the store keeps it in memory for the app session only (intentionally not
  // persisted; availability is lost on restart).
  const preUndoId = useAppStore((s) => s.preUndoByTurnCheckpoint[checkpointId])
  const restoredTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
      if (restoredTimer.current) clearTimeout(restoredTimer.current)
    },
    []
  )

  const fetchDiff = useCallback(async () => {
    try {
      const next = await window.electronAPI.checkpointDiff(checkpointId)
      if (aliveRef.current) setDiff(next)
    } catch {
      if (aliveRef.current) setDiff(null)
    }
  }, [checkpointId])

  // One lazy fetch per completed turn, on mount.
  useEffect(() => {
    void fetchDiff()
  }, [fetchDiff])

  const reportFailure = (log: string) => {
    if (!sessionId) return
    useAppStore.getState().addMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'system',
      content: t('rollback.failed', { log })
    })
  }

  const runUndo = async () => {
    if (busy) return
    setBusy('undo')
    try {
      const result = await window.electronAPI.checkpointRestore(checkpointId)
      if (result.ok) {
        // The worktree just changed underneath the changes tab / git chip.
        useAppStore.getState().bumpGitInfoVersion()
        if (result.preUndoCheckpointId) {
          // Reversible undo: record the redo target; the store flip moves the
          // row into its undone state (restored pill + 重做) right away.
          useAppStore.getState().setPreUndoForTurn(checkpointId, result.preUndoCheckpointId)
        }
        if (!aliveRef.current) return
        if (result.preUndoCheckpointId) {
          // Refresh so a later redo re-measures against the undone worktree,
          // not the stale pre-undo diff.
          void fetchDiff()
        } else {
          // No pre-undo snapshot was possible: old behavior — let the
          // restored confirmation breathe, then re-measure; the diff usually
          // collapses to zero and the row quietly disappears.
          setFlashRestored(true)
          restoredTimer.current = setTimeout(() => {
            if (!aliveRef.current) return
            setFlashRestored(false)
            void fetchDiff()
          }, 2200)
        }
      } else {
        if (!aliveRef.current) return
        reportFailure(result.log)
      }
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const runRedo = async () => {
    // Single click (no two-stage confirm): redo restores what the user just
    // deliberately undid, and it is itself reversible — the restore snapshots
    // the current worktree first.
    if (busy || !preUndoId) return
    setBusy('redo')
    try {
      const result = await window.electronAPI.checkpointRestore(preUndoId)
      if (result.ok) {
        useAppStore.getState().bumpGitInfoVersion()
        // Re-measure BEFORE leaving the undone state so the row flips in one
        // render: back to the change chip when files differ again, quietly
        // gone when they don't. The restore minted a fresh pre-undo snapshot
        // of the undone state; dropping our mapping is safe — any further
        // undo snapshots afresh.
        let next: CheckpointDiff | null = null
        try {
          next = await window.electronAPI.checkpointDiff(checkpointId)
        } catch {
          next = null
        }
        useAppStore.getState().setPreUndoForTurn(checkpointId, null)
        if (!aliveRef.current) return
        setDiff(next)
      } else {
        if (!aliveRef.current) return
        reportFailure(result.log)
      }
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  // Two-stage confirm, same pattern as the message hover rollback button.
  const { confirming: confirmUndo, click: handleUndoClick } = useConfirm(() => {
    void runUndo()
  })

  if (flashRestored) {
    return (
      <div className="msg-in flex">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          <Check size={11} />
          {t('turn.restored')}
        </span>
      </div>
    )
  }

  const phase = turnChangesPhase(diff, preUndoId !== undefined)

  if (phase === 'undone') {
    return (
      <div className="msg-in flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          <Check size={11} />
          {t('turn.restored')}
        </span>
        <button
          onClick={() => void runRedo()}
          disabled={busy !== null}
          title={busy === 'redo' ? t('rollback.restoring') : t('turn.redo')}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-ink-850/60 px-2.5 py-1 text-[11px] text-cream-dim transition hover:border-line-strong hover:text-cream disabled:opacity-60"
        >
          {busy === 'redo' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Redo2 size={11} className="shrink-0" />
          )}
          {busy === 'redo' ? t('rollback.restoring') : t('turn.redo')}
        </button>
      </div>
    )
  }

  // Not fetched yet, nothing changed since the checkpoint, or the diff is
  // unavailable (non-git project / garbage-collected snapshot): no noise.
  // (Mirrors the helper's hidden rule so `diff` narrows for the JSX below.)
  if (phase === 'hidden' || !diff || diff.files.length === 0) return null

  return (
    <div className="msg-in">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          title={open ? t('turn.hideFiles') : t('turn.showFiles')}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ink-850/60 px-2.5 py-1 text-[11px] text-cream-dim transition hover:border-line-strong hover:text-cream"
        >
          <FileDiff size={11} className="shrink-0 text-cream-faint" />
          <span>{t('turn.filesChanged', { count: diff.files.length })}</span>
          <span className="shrink-0 font-mono text-[10px] leading-none">
            <span className="text-emerald-500">+{diff.additions}</span>
            <span className="mx-0.5 text-cream-faint">/</span>
            <span className="text-red-500">-{diff.deletions}</span>
          </span>
          {open ? (
            <ChevronDown size={11} className="shrink-0 text-cream-faint" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-cream-faint" />
          )}
        </button>
        <button
          onClick={handleUndoClick}
          disabled={busy !== null}
          title={
            busy === 'undo'
              ? t('rollback.restoring')
              : confirmUndo
                ? t('rollback.confirm')
                : t('turn.undo')
          }
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition disabled:opacity-60 ${
            confirmUndo
              ? 'border-red-500/40 bg-red-500/10 text-red-500'
              : 'border-line bg-ink-850/60 text-cream-dim hover:border-line-strong hover:text-cream'
          }`}
        >
          {busy === 'undo' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Undo2 size={11} className="shrink-0" />
          )}
          {busy === 'undo' ? t('rollback.restoring') : confirmUndo ? t('rollback.confirm') : t('turn.undo')}
        </button>
      </div>
      {open && (
        <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-ink-850/50">
          <div className="divide-y divide-line">
            {diff.files.map((file) => (
              <div key={file.path} className="flex items-center gap-2 px-2.5 py-1">
                <span
                  title={file.status}
                  className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${FILE_STATUS_CLASS[file.status]}`}
                >
                  {FILE_STATUS_LETTER[file.status]}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cream">
                  {file.path}
                </span>
                {file.additions !== null && (
                  <span className="shrink-0 font-mono text-[10px] text-emerald-500">
                    +{file.additions}
                  </span>
                )}
                {file.deletions !== null && (
                  <span className="shrink-0 font-mono text-[10px] text-red-500">
                    -{file.deletions}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
