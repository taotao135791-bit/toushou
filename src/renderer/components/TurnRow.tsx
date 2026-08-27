import { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { MessageLike } from '../store'
import {
  TurnActivity,
  TurnCounts,
  TurnSummary,
  TurnVerb,
  classifyTool,
  emptyTurnCounts
} from '../lib/execution'
import { I18nKey, useT } from '../i18n'
import { formatSeconds } from '../lib/time'
import ToolCallCard from './ToolCallCard'

const VERB_KEYS: Record<TurnVerb, I18nKey> = {
  read: 'turn.verb.read',
  search: 'turn.verb.search',
  run: 'turn.verb.run',
  edit: 'turn.verb.edit',
  call: 'turn.verb.call'
}

/** Counter segments of a turn row, in display order; zero counts are hidden. */
const COUNT_SEGMENTS: { field: keyof TurnCounts; liveKey: I18nKey; summaryKey: I18nKey }[] = [
  { field: 'filesRead', liveKey: 'turn.count.read', summaryKey: 'turn.summary.read' },
  { field: 'searches', liveKey: 'turn.count.search', summaryKey: 'turn.count.search' },
  { field: 'commands', liveKey: 'turn.count.run', summaryKey: 'turn.count.run' },
  { field: 'edits', liveKey: 'turn.count.edit', summaryKey: 'turn.count.edit' },
  { field: 'toolCalls', liveKey: 'turn.count.tools', summaryKey: 'turn.count.tools' }
]

/** Derive the counters of a historical tool group from its own messages. */
function countsForRun(run: MessageLike[]): TurnCounts {
  const counts = emptyTurnCounts()
  for (const m of run) {
    if (!m.toolCall) continue
    const verb = classifyTool(m.toolCall.tool)
    if (verb === 'read') counts.filesRead++
    else if (verb === 'search') counts.searches++
    else if (verb === 'run') counts.commands++
    else if (verb === 'edit') counts.edits++
    else counts.toolCalls++
  }
  return counts
}

function segmentTexts(
  counts: TurnCounts,
  summary: boolean,
  t: (key: I18nKey, vars?: Record<string, string | number>) => string
): string[] {
  return COUNT_SEGMENTS.filter((s) => counts[s.field] > 0).map((s) =>
    t(summary ? s.summaryKey : s.liveKey, { count: counts[s.field] })
  )
}

/**
 * Live progress line above the streaming tool group: spinner, the current
 * action ("正在读取 src/x.ts"), then the counters collected so far this turn.
 */
export function LiveTurnRow({ activity }: { activity: TurnActivity }) {
  const t = useT()
  const segments = segmentTexts(activity.counts, false, t)
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
  /** Consecutive tool-call messages collapsed into one group. */
  run: MessageLike[]
  /** This group's turn is streaming: it stays expanded, the live row shows. */
  streaming: boolean
  /** Live counters — passed only to the current turn's last group. */
  activity?: TurnActivity
  /** Frozen counters of the last finished turn — same targeting as activity. */
  summary?: TurnSummary
}

/**
 * One bordered group of consecutive tool calls. While the turn streams the
 * group stays expanded under a LiveTurnRow; afterwards it collapses behind a
 * static summary row ("已处理 37s · 读取 3 文件 · 调用 2 个工具").
 */
export function ToolGroup({ run, streaming, activity, summary }: ToolGroupProps) {
  const [open, setOpen] = useState(false)
  const t = useT()
  const live = streaming && activity
  const expanded = streaming || open
  const counts = summary?.counts ?? countsForRun(run)
  const parts = summary
    ? [t('turn.summary.elapsed', { s: formatSeconds(summary.elapsedMs) }), ...segmentTexts(counts, true, t)]
    : segmentTexts(counts, true, t)

  return (
    <div>
      {live ? (
        <LiveTurnRow activity={activity} />
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          title={t('turn.toggle')}
          className="flex h-8 w-full items-center gap-2 px-1 text-left text-[12px] text-cream-faint transition-colors hover:text-cream-dim"
        >
          <span className="shrink-0">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <span className="min-w-0 truncate">{parts.join(' · ')}</span>
        </button>
      )}
      {expanded && (
        <div className="msg-in overflow-hidden rounded-xl border border-line bg-ink-850/50">
          <div className="divide-y divide-line">
            {run.map((m) => (
              <ToolCallCard key={m.id} toolCall={m.toolCall!} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
