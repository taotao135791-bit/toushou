import { useEffect } from 'react'
import { useAppStore } from '../store'
import { useT } from '../i18n'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface UsageMonitorProps {
  sessionId: string
}

/**
 * Usage readout in the composer's status bar: token usage, prompt-cache hit
 * rate and context-window fill for the active session, plus a live indicator
 * while compaction runs. Backed by the RPC get_session_stats command;
 * refreshes after every turn and periodically while the agent works.
 */
export default function UsageMonitor({ sessionId }: UsageMonitorProps) {
  const t = useT()
  const stats = useAppStore((s) => s.stats[sessionId])
  const busy = useAppStore((s) => Boolean(s.busy[sessionId]))
  const compacting = useAppStore((s) => Boolean(s.compacting[sessionId]))
  const setStats = useAppStore((s) => s.setStats)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const next = await window.electronAPI.getSessionStats(sessionId)
      if (!cancelled && next) setStats(sessionId, next)
    }
    refresh()
    // Turns/compactions update the counters — poll while either is active
    if (!busy && !compacting) return
    const timer = setInterval(refresh, 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, busy, compacting, setStats])

  if (compacting) {
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-accent">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        {t('usage.compacting')}
      </div>
    )
  }

  if (!stats || stats.tokens.total === 0) return null

  const { tokens, contextUsage, cost } = stats
  const cacheBase = tokens.input + tokens.cacheRead
  const cacheHit = cacheBase > 0 ? Math.round((tokens.cacheRead / cacheBase) * 100) : 0
  const ctxPercent =
    contextUsage?.percent != null
      ? Math.round(contextUsage.percent)
      : contextUsage?.tokens != null && contextUsage.contextWindow > 0
        ? Math.round((contextUsage.tokens / contextUsage.contextWindow) * 100)
        : null

  return (
    <div
      className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-cream-faint"
      title={t('usage.tooltip')}
    >
      <span>
        {formatTokens(tokens.total)} {t('usage.tokens')}
      </span>
      {cacheBase > 0 && (
        <span className={cacheHit >= 50 ? 'text-accent' : ''}>
          {t('usage.cache')} {cacheHit}%
        </span>
      )}
      {ctxPercent != null && (
        <span
          className={
            ctxPercent >= 80
              ? 'text-red-500'
              : ctxPercent >= 60
                ? 'text-yellow-600 dark:text-yellow-400'
                : ''
          }
        >
          {t('usage.context')} {ctxPercent}%
        </span>
      )}
      {cost > 0 && <span>${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}</span>}
    </div>
  )
}
