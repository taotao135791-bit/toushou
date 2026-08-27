import { useEffect, useMemo, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Loader2, MessageSquareText, Route } from 'lucide-react'
import type { SubagentMessagesResult } from '@shared/types'
import { useAppStore } from '../store'
import type { AgentNode, TrajectoryEntry } from '../lib/execution'
import { formatSeconds } from '../lib/time'
import { useT } from '../i18n'
import type { I18nKey } from '../i18n'

interface TranscriptState {
  loading: boolean
  result?: SubagentMessagesResult
  failed?: boolean
}

const TRANSCRIPT_ENTRY_MAX_CHARS = 4_000

const AGENT_STATUS_KEYS: Record<AgentNode['status'], I18nKey> = {
  pending: 'agents.status.pending',
  running: 'agents.status.running',
  completed: 'agents.status.completed',
  failed: 'agents.status.failed',
  aborted: 'agents.status.aborted',
  unknown: 'agents.status.unknown'
}

const TRAJECTORY_KIND_KEYS: Record<TrajectoryEntry['kind'], I18nKey> = {
  reasoning: 'agents.event.reasoning',
  message: 'agents.event.message',
  tool: 'agents.event.tool',
  subagent: 'agents.event.subagent',
  steer: 'agents.event.steer'
}

function clipTranscript(text: string): string {
  return text.length > TRANSCRIPT_ENTRY_MAX_CHARS
    ? `${text.slice(0, TRANSCRIPT_ENTRY_MAX_CHARS)}…`
    : text
}

function statusClass(status: AgentNode['status']): string {
  switch (status) {
    case 'running':
      return 'bg-amber-400'
    case 'completed':
      return 'bg-emerald-500'
    case 'failed':
    case 'aborted':
      return 'bg-red-500'
    default:
      return 'bg-cream-faint'
  }
}

/**
 * The runtime deliberately returns child transcript entries as opaque values.
 * Render a small, bounded text view rather than guessing at an upstream schema
 * or serializing a huge child session into the parent chat.
 */
export function transcriptEntryText(entry: unknown): string {
  if (typeof entry === 'string') return clipTranscript(entry)
  if (entry && typeof entry === 'object') {
    const value = entry as { role?: unknown; content?: unknown; text?: unknown }
    const role = typeof value.role === 'string' ? `${value.role}: ` : ''
    const content = typeof value.content === 'string' ? value.content : value.text
    if (typeof content === 'string') return clipTranscript(`${role}${content}`)
  }
  try {
    return clipTranscript(JSON.stringify(entry))
  } catch {
    return clipTranscript(String(entry))
  }
}

function compactTask(agent: AgentNode): string | undefined {
  return agent.assignment ?? agent.task ?? agent.description ?? agent.currentTool
}

function latestTrajectory(
  turnOrder: string[],
  turns: Record<string, { trajectory: TrajectoryEntry[] }>
): TrajectoryEntry[] {
  return turnOrder.flatMap((id) => turns[id]?.trajectory ?? []).slice(-12)
}

/**
 * A compact, in-transcript Agent Hub. It is intentionally conditional: a
 * normal single-agent conversation remains as quiet as before, while a session
 * that uses subagents exposes the roster, trajectory facts and a read-only
 * child transcript action.
 */
export default function ExecutionActivity({ sessionId }: { sessionId: string | null }) {
  const projection = useAppStore((s) => (sessionId ? s.executions[sessionId] : undefined))
  const t = useT()
  const [open, setOpen] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptState>>({})

  useEffect(() => {
    setOpen(false)
    setSelectedAgentId(null)
    setTranscripts({})
  }, [sessionId])

  const agents = useMemo(
    () =>
      Object.values(projection?.agents ?? {}).sort(
        (a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
      ),
    [projection]
  )
  const trajectory = useMemo(
    () => latestTrajectory(projection?.turnOrder ?? [], projection?.turns ?? {}),
    [projection]
  )

  if (!projection || (agents.length === 0 && trajectory.length === 0)) return null

  const selectedAgent = selectedAgentId ? projection.agents[selectedAgentId] : undefined
  const selectedTranscript = selectedAgentId ? transcripts[selectedAgentId] : undefined

  const openTranscript = async (agent: AgentNode) => {
    if (!sessionId || !(agent.id || agent.sessionFile)) return
    const previous = transcripts[agent.id]
    setSelectedAgentId(agent.id)
    if (previous?.result || previous?.loading) return
    setTranscripts((state) => ({ ...state, [agent.id]: { loading: true } }))
    try {
      const result = await window.electronAPI.getSubagentMessages(sessionId, {
        subagentId: agent.id,
        sessionFile: agent.sessionFile
      })
      setTranscripts((state) => ({
        ...state,
        [agent.id]: result ? { loading: false, result } : { loading: false, failed: true }
      }))
    } catch {
      setTranscripts((state) => ({ ...state, [agent.id]: { loading: false, failed: true } }))
    }
  }

  return (
    <section className="mx-6 mb-2 overflow-hidden rounded-xl border border-line bg-ink-850/60">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-cream-dim transition-colors hover:bg-overlay hover:text-cream"
      >
        <Bot size={13} className="text-accent" />
        <span className="font-medium text-cream">{t('agents.title')}</span>
        {agents.length > 0 && <span className="text-cream-faint">{t('agents.count', { count: agents.length })}</span>}
        <span className="ml-auto text-cream-faint">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {open && (
        <div className="divide-y divide-line/60 border-t border-line/60">
          {agents.length > 0 && (
            <div className="space-y-1.5 p-3">
              {agents.map((agent) => {
                const task = compactTask(agent)
                const selected = selectedAgentId === agent.id
                return (
                  <div key={agent.id} className="rounded-lg border border-line/70 bg-ink-850 px-2.5 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass(agent.status)}`} />
                      <span className="min-w-0 truncate text-[12px] font-medium text-cream">{agent.agent}</span>
                      <span className="shrink-0 text-[10.5px] text-cream-faint">{t(AGENT_STATUS_KEYS[agent.status])}</span>
                      {(agent.id || agent.sessionFile) && (
                        <button
                          onClick={() => void openTranscript(agent)}
                          aria-expanded={selected}
                          className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-cream-faint transition-colors hover:bg-overlay hover:text-cream"
                        >
                          <MessageSquareText size={11} />
                          {t('agents.transcript')}
                        </button>
                      )}
                    </div>
                    {task && <p className="mt-1 truncate text-[11px] text-cream-faint" title={task}>{task}</p>}
                    {(agent.resolvedModel || agent.durationMs !== undefined || agent.tokens !== undefined) && (
                      <p className="mt-1 text-[10.5px] text-cream-faint">
                        {[
                          agent.resolvedModel,
                          agent.durationMs !== undefined ? t('agents.duration', { s: formatSeconds(agent.durationMs) }) : undefined,
                          agent.tokens !== undefined ? t('agents.tokens', { count: agent.tokens }) : undefined
                        ].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {selectedAgent && (
            <div className="p-3">
              <div className="mb-1.5 text-[11px] font-medium text-cream-dim">{t('agents.transcriptOf', { name: selectedAgent.agent })}</div>
              {selectedTranscript?.loading ? (
                <div className="flex items-center gap-1.5 text-[11px] text-cream-faint"><Loader2 size={11} className="animate-spin" />{t('agents.loading')}</div>
              ) : selectedTranscript?.failed ? (
                <p className="text-[11px] text-red-500">{t('agents.transcriptUnavailable')}</p>
              ) : selectedTranscript?.result ? (
                selectedTranscript.result.messages.length > 0 ? (
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-overlay px-2.5 py-2 font-mono text-[10.5px] leading-5 text-cream-dim">
                    {selectedTranscript.result.messages.slice(0, 30).map((entry, index) => (
                      <div key={index}>{transcriptEntryText(entry)}</div>
                    ))}
                  </pre>
                ) : <p className="text-[11px] text-cream-faint">{t('agents.transcriptEmpty')}</p>
              ) : null}
            </div>
          )}

          {trajectory.length > 0 && (
            <div className="p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-cream-dim"><Route size={11} />{t('agents.trajectory')}</div>
              <ol className="space-y-1">
                {trajectory.map((entry) => (
                  <li key={`${entry.seq}-${entry.kind}`} className="flex min-w-0 gap-2 text-[11px] text-cream-faint">
                    <span className="w-14 shrink-0 text-cream-faint/70">{t(TRAJECTORY_KIND_KEYS[entry.kind])}</span>
                    <span className="truncate text-cream-dim" title={entry.label}>{entry.label}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
