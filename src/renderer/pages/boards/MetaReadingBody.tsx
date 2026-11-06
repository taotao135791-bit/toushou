import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { BoardWidget } from '@shared/types'
import { isMetaReadingRange, type MetaReadingAccount, type MetaReadingSummary } from '@shared/metaReading'
import { useAppStore } from '../../store'
import { publishMetaReading } from './metaReadingStore'

export function MetaReadingBody({ widget, onConfigChange }: { widget: BoardWidget; onConfigChange: (config: Record<string, unknown>) => void }) {
  const zh = useAppStore(state => state.language) === 'zh'
  const accountId = typeof widget.config.accountId === 'string' ? widget.config.accountId : ''
  const range = isMetaReadingRange(widget.config.range) ? widget.config.range : 'last7'
  const rangeLabel = (zh ? { today: '今天', yesterday: '昨天', last3: '近3天', last7: '近7天', last30: '近30天' } : { today: 'Today', yesterday: 'Yesterday', last3: 'Last 3 days', last7: 'Last 7 days', last30: 'Last 30 days' })[range]
  const [accounts, setAccounts] = useState<MetaReadingAccount[]>([])
  const [summary, setSummary] = useState<MetaReadingSummary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [partial, setPartial] = useState(false)
  const version = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++version.current
    setBusy(true); setError(''); setSummary(null); publishMetaReading(widget.id, null)
    try {
      const result = await window.electronAPI.metaAdsReading(accountId ? { action: 'summary', accountId, range } : { action: 'accounts' })
      if (ticket !== version.current) return
      if (!result.ok) { setError(result.error); return }
      if ('accounts' in result.data) { setAccounts(result.data.accounts); setPartial(result.data.partial) }
      else { setSummary(result.data); publishMetaReading(widget.id, result.data) }
    } catch { if (ticket === version.current) setError(zh ? 'Meta 读取失败，请重试。' : 'Meta reading failed. Retry.') }
    finally { if (ticket === version.current) setBusy(false) }
  }, [accountId, range, widget.id, zh])
  useEffect(() => {
    setSummary(null); publishMetaReading(widget.id, null)
    if (accountId) void load()
    return () => { ++version.current; publishMetaReading(widget.id, null) }
  }, [load, accountId, widget.id])
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent).detail?.widgetId !== widget.id) return
      void load().finally(() => window.dispatchEvent(new CustomEvent('meta-reading:module-done', { detail: { widgetId: widget.id } })))
    }
    window.addEventListener('meta-reading:board-refresh', refresh)
    return () => window.removeEventListener('meta-reading:board-refresh', refresh)
  }, [load, widget.id])
  useEffect(() => window.electronAPI.onMetaAdsStatus(status => {
    if (!status.connected) { ++version.current; setSummary(null); setAccounts([]); setBusy(false); publishMetaReading(widget.id, null); setError(zh ? 'Meta 已断开，请在连接页重新授权。' : 'Meta disconnected. Reconnect in Connections.') }
  }), [widget.id, zh])
  const sum = (key: 'spend' | 'impressions' | 'clicks'): number | null => summary?.rows.length && summary.rows.every(row => row[key] !== null) ? summary.rows.reduce((n, row) => n + row[key]!, 0) : null
  const spend = sum('spend'), impressions = sum('impressions'), clicks = sum('clicks')
  const format = (value: number | null) => value === null ? (busy ? (zh ? '读取中…' : 'Loading…') : '—') : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const labels = zh ? ['消耗', '展示', '点击', '点击率', '单次点击成本', '千次展示成本'] : ['Spend', 'Impressions', 'Clicks', 'CTR', 'CPC', 'CPM']
  const values = [summary?.account.currency ? format(spend) : '—', format(impressions), format(clicks), impressions && clicks !== null ? `${format(clicks / impressions * 100)}%` : '—', spend !== null && clicks ? format(spend / clicks) : '—', spend !== null && impressions ? format(spend / impressions * 1000) : '—']
  return <div className="flex h-full flex-col gap-3 overflow-auto text-[12px] text-cream-dim">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p>{(summary?.account.name ?? accountId) || (zh ? '请选择已授权的 Meta 广告账户' : 'Select an authorized Meta ad account')}</p><p className="text-cream-faint">{rangeLabel} · {summary?.start ?? '—'} ~ {summary?.end ?? '—'}{summary?.account.currency ? ` · ${summary.account.currency}` : ''}</p></div>
      <button className="focus-ring flex items-center gap-1 rounded-full border border-line px-3 py-1.5 disabled:opacity-50" disabled={busy} onClick={() => void load()}><RefreshCw size={12} />{busy ? (zh ? '读取中…' : 'Loading…') : accountId ? (zh ? '刷新' : 'Refresh') : (zh ? '加载账户' : 'Load accounts')}</button>
    </div>
    <div className="flex items-center gap-2">
      <select aria-label={zh ? 'Meta 广告账户' : 'Meta ad account'} className="min-w-0 flex-1 rounded-lg border border-line bg-ink-850 p-2" disabled={busy} value={accountId} onChange={event => onConfigChange({ ...widget.config, accountId: event.target.value })}>
        <option value="">{zh ? '选择账户（先加载账户）' : 'Select an account (load first)'}</option>
        {accountId && !accounts.some(account => account.id === accountId) && <option value={accountId}>{summary?.account.name ?? accountId}</option>}
        {accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.currency ?? '?'}</option>)}
      </select>
      {accountId && <button disabled={busy} className="rounded-full border border-line px-3 py-1.5" onClick={() => onConfigChange({ ...widget.config, accountId: '' })}>{zh ? '换账户' : 'Change account'}</button>}
    </div>
    {error && <p role="alert" className="text-red-500">{error} <a href="#/connections" className="underline">{zh ? '连接设置' : 'Connections'}</a></p>}
    {partial && <p>{zh ? '账户列表尚有后续分页，仅展示当前返回的账户。' : 'Account list is partial; only returned accounts are selectable.'}</p>}
    {summary && !summary.rows.length && <p>{zh ? '该范围没有返回明细，不将缺失值填成零。' : 'No rows returned for this range.'}</p>}
    <div className="grid grid-cols-2 gap-3">{labels.map((label, index) => <div key={label} className="rounded-xl bg-ink-850 px-2.5 py-2"><div className="text-cream-faint">{label}</div><div className="text-[20px] font-semibold tabular-nums text-cream">{values[index]}</div></div>)}</div>
    <p className="text-cream-faint">Pipeboard Meta Ads MCP · {zh ? '只读 · 账户统计日；时区' : 'Read only · Account reporting dates; timezone'}: {summary?.account.timezone ?? (zh ? '待确认' : 'unverified')}{summary ? ` · ${zh ? '读取于' : 'Read at'} ${new Date(summary.readAt).toLocaleString()}` : ''}</p>
  </div>
}
