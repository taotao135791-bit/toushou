import { Loader2 } from 'lucide-react'
import { MessageLike } from '../store'
import { TurnActivity, TurnSummary, TurnVerb } from '../lib/execution'
import { I18nKey, useT } from '../i18n'
import { formatSeconds } from '../lib/time'
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
export function ToolGroup({ run, streaming, activity, summary }: ToolGroupProps) {
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
}
