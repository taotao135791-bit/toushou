import { useEffect, useRef, useState } from 'react'
import type { SessionStats } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import MenuPortal from './MenuPortal'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(n)
}

function contextFill(usage: SessionStats['contextUsage']): string | null {
  if (!usage || !(usage.contextWindow > 0)) return null
  const percent = usage.tokens != null ? 100 * usage.tokens / usage.contextWindow : usage.percent
  if (percent == null || !Number.isFinite(percent) || percent < 0) return null
  return percent > 0 && percent < 1 ? '<1%' : Math.round(percent) + '%'
}

export function ContextReadout({ sessionId }: { sessionId: string }) {
  const t = useT()
  const usage = useAppStore(s => s.stats[sessionId]?.contextUsage)
  const fill = contextFill(usage)
  const windowLabel = usage && usage.contextWindow > 0 ? formatTokens(usage.contextWindow) : null
  return <span className="tabular-nums">
    {fill ? `${fill}${windowLabel && usage?.tokens != null ? ` · ${formatTokens(usage.tokens)} / ${windowLabel} tokens` : ''}`
      : windowLabel ? t('usage.windowOnly', { size: windowLabel }) : t('usage.unavailable')}
  </span>
}

export default function UsageMonitor({ sessionId, onCompact, disabled }: {
  sessionId: string
  onCompact?: () => void
  disabled?: boolean
}) {
  const t = useT()
  const total = useAppStore(s => s.stats[sessionId]?.tokens.total)
  const busy = useAppStore(s => Boolean(s.busy[sessionId]))
  const compacting = useAppStore(s => Boolean(s.compacting[sessionId]))
  const modelVersion = useAppStore(s => s.sessionModelVersion[sessionId])
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (sessionId.startsWith('preview:')) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const stats = await window.electronAPI.getSessionStats(sessionId)
        if (active && stats) useAppStore.getState().setStats(sessionId, stats)
      } catch { /* The session may close during an in-flight request. */ }
      if (active && (busy || compacting)) timer = setTimeout(refresh, 4000)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [sessionId, busy, compacting, modelVersion, open])
  return <div className="mt-0.5 flex items-center text-[11px] leading-4 text-cream-faint">
    <button ref={trigger} type="button" aria-expanded={open} aria-haspopup="dialog"
      aria-label={t('usage.openCompact')} title={t('usage.openCompact')}
      onClick={() => setOpen(v => !v)}
      className="focus-ring rounded px-0.5 font-mono tabular-nums hover:text-cream">
      {total == null ? '—' : formatTokens(total)} {t('usage.tokens')}
    </button>
    <MenuPortal open={open} triggerRef={trigger} onClose={() => setOpen(false)} width={268}>
      <div role="dialog" aria-label={t('usage.openCompact')} className="space-y-2 px-2 py-1.5 text-xs text-cream">
        <div className="font-medium">{t('usage.openCompact')}</div>
        <div className="text-cream-dim"><ContextReadout sessionId={sessionId} /></div>
        <button type="button" disabled={!onCompact || disabled || busy || compacting}
          onClick={onCompact} className="focus-ring rounded-md border border-line px-2.5 py-1 hover:bg-overlay disabled:opacity-50">
          {t(compacting ? 'usage.compacting' : busy ? 'usage.waitForTurn' : 'composer.slashCompact')}
        </button>
      </div>
    </MenuPortal>
  </div>
}
