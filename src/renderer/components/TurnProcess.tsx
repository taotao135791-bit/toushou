import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight, CircleAlert, Loader2 } from 'lucide-react'
import type { IndexedChatMessage } from '../lib/chatFlow'
import { presentToolCall } from '../lib/toolPresentation'
import { toolBrandForCall, websiteSourceForCall } from '../lib/toolBrand'
import { formatSeconds } from '../lib/time'
import { useAppStore } from '../store'
import MessageItem from './MessageItem'
import ToolCallCard from './ToolCallCard'
import BrandIcon from './BrandIcon'
import WebsiteIcon from './WebsiteIcon'

interface Props { entries: IndexedChatMessage[]; sessionId: string | null; active: boolean; elapsedMs?: number; lastUserIndex?: number }

/**
 * 象征性建板进度（用户要求：长任务给出大致进度与预计时间）。进度由本轮
 * 已见过的看板流水线工具推导，不是精确的步骤计数——是"大概到哪了"。
 */
const BOARD_PROGRESS_LADDER: Array<{ re: RegExp; p: number; label: string; labelZh: string }> = [
  { re: /board_build_begin/, p: 5, label: 'Freezing requirements', labelZh: '冻结要求' },
  { re: /tiktok_update|af_dataset_pull|appsflyer_apps|board_meta_accounts/, p: 30, label: 'Pulling data', labelZh: '拉取数据' },
  { re: /board_create/, p: 45, label: 'Creating board', labelZh: '创建看板' },
  { re: /board_add_widget|board_customize/, p: 65, label: 'Adding widgets', labelZh: '添加组件' },
  { re: /board_refresh/, p: 80, label: 'Refreshing data', labelZh: '刷新数据' },
  { re: /board_check|board_build_preflight/, p: 90, label: 'Validating', labelZh: '验收检查' },
  { re: /board_build_commit/, p: 97, label: 'Saving', labelZh: '保存看板' }
]

function boardPipelineProgress(entries: IndexedChatMessage[]): { p: number; label: string; labelZh: string } | null {
  const names = entries.flatMap((entry) => (entry.message.toolCall?.tool ? [entry.message.toolCall.tool.replace(/^toushou_/, '')] : []))
  if (!names.some((name) => /board_(build_begin|create|add_widget|refresh|build_commit)/.test(name))) return null
  let p = 0
  let label = ''
  let labelZh = ''
  for (const name of names) {
    for (const step of BOARD_PROGRESS_LADDER) {
      if (step.re.test(name) && step.p >= p) {
        p = step.p
        label = step.label
        labelZh = step.labelZh
      }
    }
  }
  return p > 0 ? { p, label, labelZh } : null
}

/** Ticking elapsed for the ACTIVE turn (used for the rough ETA). */
function useActiveElapsed(active: boolean, key: string): number {
  const startedAt = useRef(Date.now())
  const [now, setNow] = useState(0)
  useEffect(() => {
    startedAt.current = Date.now()
  }, [key])
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, key])
  return active && now ? now - startedAt.current : 0
}

/** Keep the complete ordered process available without competing with the result. */
function TurnProcess({ entries, sessionId, active, elapsedMs, lastUserIndex }: Props) {
  const language = useAppStore(state => state.language)
  const zh = language === 'zh'
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const { stepCount, failed, last, action, website, brands, progress } = useMemo(() => {
    const calls = entries.flatMap(entry => entry.message.toolCall ? [entry.message.toolCall] : [])
    const last = active ? calls.at(-1) : undefined
    return {
      stepCount: calls.length,
      failed: calls.filter(call => presentToolCall(call, language).status === 'failed').length,
      last,
      action: last ? presentToolCall(last, language).label : null,
      website: last ? websiteSourceForCall(last) : null,
      brands: last ? [] : [...new Set(calls.map(toolBrandForCall).filter(brand => brand !== null))].slice(0, 3),
      progress: active ? boardPipelineProgress(entries) : null
    }
  }, [entries, language, active])
  const activeElapsed = useActiveElapsed((progress?.p ?? 0) >= 10, id)
  // Rough ETA: scale elapsed by the remaining fraction. Deliberately symbolic —
  // shown only once there is enough signal (≥10% progress, ≥15s elapsed).
  const etaSeconds = progress && active && progress.p >= 10 && activeElapsed >= 15_000
    ? Math.round((activeElapsed * (100 - progress.p)) / progress.p / 1000)
    : null
  return <section className="min-w-0" aria-label={zh ? '本轮执行过程' : 'Turn activity'}>
    <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}
      className="focus-ring flex min-h-9 w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 text-left text-[12px] text-cream-dim transition-colors hover:bg-overlay">
      {active ? <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" /> : failed ? <CircleAlert size={14} className="shrink-0 text-red-500" aria-hidden="true" /> : <ChevronRight size={14} className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />}
      {website ? <WebsiteIcon url={website.url} hostname={website.hostname} size={16} /> : active && last ? <BrandIcon brand={toolBrandForCall(last)} size={16} /> :
        brands.length > 0 && <span className="inline-flex shrink-0 items-center gap-1.5" aria-hidden="true">{brands.map(brand => <BrandIcon key={brand} brand={brand} size={16} />)}</span>}
      <span className="min-w-0 flex-1 basis-[100px] truncate font-medium">{action ?? (zh ? '执行过程' : 'Activity')}</span>
      {website && <span className="max-w-[180px] truncate text-cream-faint">{website.hostname}</span>}
      <span className="shrink-0 text-cream-faint">{zh ? `${stepCount} 个步骤` : `${stepCount} steps`}</span>
      {failed > 0 && <span className="shrink-0 text-red-500">{zh ? `${failed} 项失败` : `${failed} failed`}</span>}
      {elapsedMs !== undefined && !active && <span className="ml-auto shrink-0 tabular-nums text-cream-faint">{formatSeconds(elapsedMs)}s</span>}
      <span className="ml-auto shrink-0 text-cream-faint">{expanded ? (zh ? '收起' : 'Hide') : (zh ? '展开' : 'Show')}</span>
    </button>
    {progress && active && (
      <div className="mt-1 px-2" aria-label={zh ? '建板进度' : 'Board progress'}>
        <div className="h-1 w-full overflow-hidden rounded-full bg-overlay">
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${progress.p}%` }} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] leading-4 text-cream-faint">
          <span>{zh ? progress.labelZh : progress.label}</span>
          <span className="tabular-nums">{progress.p}%</span>
          {etaSeconds !== null && etaSeconds > 5 && (
            <span className="tabular-nums">{zh ? `预计还需约 ${etaSeconds > 90 ? `${Math.round(etaSeconds / 60)} 分钟` : `${etaSeconds} 秒`}` : `~${etaSeconds > 90 ? `${Math.round(etaSeconds / 60)} min` : `${etaSeconds}s`} left`}</span>
          )}
        </div>
      </div>
    )}
    <div id={id} hidden={!expanded} className="mt-2 space-y-3 border-l border-line pl-3">
      {expanded && entries.map(({ message, index }, entryIndex) => <div key={message.id} data-message-id={message.id} className="min-w-0">
        {message.toolCall ? <ToolCallCard toolCall={message.toolCall} /> : <MessageItem message={message} index={index} lastUserIndex={lastUserIndex}
          sessionId={sessionId} streaming={active && entryIndex === entries.length - 1} allowThinkingAutoExpand={false} showBoardAction={false} />}
      </div>)}
    </div>
  </section>
}

export default memo(TurnProcess, (before, after) => before.sessionId === after.sessionId && before.active === after.active && before.elapsedMs === after.elapsedMs &&
  before.entries.length === after.entries.length && before.entries.every((entry, index) => entry.index === after.entries[index].index && entry.message === after.entries[index].message))
