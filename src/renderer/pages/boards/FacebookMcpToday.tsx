import { useCallback, useEffect, useRef, useState } from 'react'
import type { MetaReadingAccount, MetaReadingSummary } from '@shared/metaReading'
import { TikTokAccountPicker } from './TikTokAccountPicker'

/** Same picker as TikTok; only discovery and reading use the Meta capability. */
export function FacebookMcpToday({ window: dateWindow, zh, onConnect }: {
  window: { start: string; end: string }; zh: boolean; onConnect: () => void
}) {
  const [results, setResults] = useState<MetaReadingSummary[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [partial, setPartial] = useState(false)
  const [ready, setReady] = useState(false)
  const [pickerVersion, setPickerVersion] = useState(0)
  const accounts = useRef<MetaReadingAccount[]>([])
  const generation = useRef(0)
  const running = useRef(false)
  const stop = useRef(false)
  const alive = useRef(true)
  const validWindow = Number.isFinite(Date.parse(dateWindow.start)) && Number.isFinite(Date.parse(dateWindow.end)) && dateWindow.start <= dateWindow.end && Date.parse(dateWindow.end) - Date.parse(dateWindow.start) <= 29 * 86_400_000
  useEffect(() => {
    alive.current = true
    const unsubscribe = window.electronAPI.onMetaAdsStatus?.(status => {
      if (status.connected) return
      ++generation.current; stop.current = true; running.current = false
      accounts.current = []; setReady(false); setResults([]); setBusy(false)
      setError(zh ? 'Facebook 已断开，请重新连接。' : 'Facebook disconnected. Reconnect to continue.')
      setPickerVersion(value => value + 1)
    })
    return () => { alive.current = false; ++generation.current; stop.current = true; unsubscribe?.() }
  }, [zh])
  const discover = useCallback(async () => {
    const ticket = ++generation.current
    accounts.current = []; setReady(false); setResults([]); setPartial(false); setProgress({ done: 0, total: 0 }); setError('')
    const result = await window.electronAPI.metaAdsReading({ action: 'accounts' })
    if (!alive.current || ticket !== generation.current) throw new Error('superseded')
    if (!result.ok || !('accounts' in result.data)) throw new Error('accounts-unavailable')
    accounts.current = result.data.accounts; setPartial(result.data.partial); setReady(true)
    return { selected: [], granted: result.data.accounts.map(account => account.id.slice(4)), accounts: result.data.accounts.map(account => ({ advertiserId: account.id.slice(4), name: account.name })), namesIncomplete: false }
  }, [])
  const read = async (ids: string[]) => {
    if (running.current || !validWindow || !ids.length) return
    if (ids.some(id => !accounts.current.some(account => account.id === id))) {
      setError(zh ? '请选择列表内已授权的账户。' : 'Select an authorized account from the list.'); return
    }
    const ticket = ++generation.current
    running.current = true; stop.current = false; setBusy(true); setResults([]); setError(''); setProgress({ done: 0, total: ids.length })
    try {
      for (const accountId of ids) {
        if (stop.current || !alive.current || ticket !== generation.current) break
        const result = await window.electronAPI.metaAdsReading({ action: 'summary', accountId, range: 'last30', window: dateWindow })
        if (!alive.current || ticket !== generation.current) return
        if (!result.ok) { setError(result.error); break }
        if ('accounts' in result.data || result.data.account.id !== accountId || result.data.start !== dateWindow.start || result.data.end !== dateWindow.end) {
          setError(zh ? '返回账户或日期不符，已停止读取。' : 'Account or dates did not match. Reading stopped.'); break
        }
        const summary = result.data
        setResults(current => [...current, summary]); setProgress(current => ({ ...current, done: current.done + 1 }))
      }
    } catch { if (alive.current && ticket === generation.current) setError(zh ? 'Facebook 读取未完成，请检查连接后重试。' : 'Facebook reading did not complete. Check the connection and retry.') }
    finally { if (alive.current && ticket === generation.current) { running.current = false; setBusy(false) } }
  }
  return <>
    <TikTokAccountPicker key={pickerVersion} discover={discover} busy={busy || !validWindow} readAllDisabled={!ready || partial}
      onReadOne={id => void read([`act_${id}`])} onReadAll={() => { if (!partial && ready) void read(accounts.current.map(account => account.id)) }} onConnect={onConnect}
      labels={{
        title: zh ? '选择 Facebook 读取范围' : 'Choose Facebook reading scope',
        accountLabel: zh ? '账户名称或广告账户 ID' : 'Account name or ad account ID',
        accountPlaceholder: zh ? '按名称搜索或输入广告账户 ID' : 'Search by name or enter an ad account ID',
        manualHint: zh ? '单次读取保留已选账户范围' : 'A single read keeps the authorized account scope',
        loading: zh ? '正在加载账户…' : 'Loading accounts…', empty: zh ? '没有可读取的已授权账户。' : 'No authorized accounts available.',
        discoveryError: zh ? '账户加载失败，请检查 Meta 连接后重试。' : 'Could not load accounts. Check the Meta connection and retry.',
        connect: zh ? '连接 Facebook' : 'Connect Facebook', namesIncomplete: zh ? '部分账户名称不可用。' : 'Some account names are unavailable.',
        noMatch: zh ? '没有匹配账户。' : 'No matching accounts.', retry: zh ? '重新获取账户' : 'Reload accounts',
        invalidId: zh ? '请输入有效的数字账户 ID。' : 'Enter a valid numeric account ID.', readOne: zh ? '读取此账户' : 'Read this account',
        readAll: zh ? '巡检全部已授权账户' : 'Inspect all authorized accounts',
        readAllHint: zh ? '巡检逐个读取已授权账户；搜索只筛选列表，不改变巡检范围。' : 'Inspection reads authorized accounts one at a time. Search only filters the list.'
      }} />
    {!validWindow && <p role="alert" className="text-[12px] text-amber-700 dark:text-amber-300">{zh ? 'Facebook 每次最多读取30天，请缩短上方日期范围。' : 'Facebook supports up to 30 days per read. Shorten the date range above.'}</p>}
    {partial && <p role="status" className="text-[12px] text-amber-700 dark:text-amber-300">{zh ? '账户列表尚有分页，可读取当前账户；为避免漏读，暂不开放全量巡检。' : 'The account list is partial. Read individual accounts; full inspection is unavailable.'}</p>}
    {progress.total > 0 && <div role="status" className="flex items-center gap-3 text-[12px] text-cream-dim">
      <span>{zh ? `已读取 ${progress.done} / ${progress.total} 个账户` : `Read ${progress.done} / ${progress.total} accounts`}</span>
      {busy && <button type="button" className="focus-ring rounded-full border border-line px-3 py-1" onClick={() => { stop.current = true }}>{zh ? '停止后续读取' : 'Stop after this account'}</button>}
    </div>}
    {error && <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
    {results.map(summary => <FacebookMcpResult key={summary.account.id} summary={summary} zh={zh} />)}
  </>
}

function FacebookMcpResult({ summary, zh }: { summary: MetaReadingSummary; zh: boolean }) {
  const sum = (key: 'spend' | 'impressions' | 'clicks') => summary.rows.length && summary.rows.every(row => row[key] !== null) ? summary.rows.reduce((total, row) => total + row[key]!, 0) : null
  const spend = summary.account.currency ? sum('spend') : null, impressions = sum('impressions'), clicks = sum('clicks')
  const format = (value: number | null) => value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const metrics = [
    [zh ? '消耗' : 'Spend', format(spend)], [zh ? '点击率' : 'CTR', impressions && clicks !== null ? `${format(clicks / impressions * 100)}%` : '—'],
    [zh ? '展示' : 'Impressions', format(impressions)], [zh ? '点击' : 'Clicks', format(clicks)],
    ['CPC', spend !== null && clicks ? format(spend / clicks) : '—'], ['CPM', spend !== null && impressions ? format(spend / impressions * 1000) : '—']
  ]
  return <article className="space-y-3 rounded-2xl border border-line bg-ink-850 p-4" aria-label={summary.account.name}>
    <h3 className="text-[14px] font-medium text-cream">{summary.account.name}</h3>
    <p className="text-[12px] text-cream-faint">{summary.start} – {summary.end} · {summary.account.currency ?? (zh ? '币种待确认' : 'Currency unverified')}</p>
    {!summary.rows.length && <p className="text-[12px] text-cream-faint">{zh ? '该范围没有返回明细。' : 'No rows returned for this range.'}</p>}
    <div className="grid grid-cols-2 gap-4">{metrics.map(([label, value]) => <div key={label}><p className="text-[12px] text-cream-faint">{label}</p><p className="text-[15px] font-medium tabular-nums text-cream">{value}</p></div>)}</div>
    <p className="text-[12px] text-cream-faint">Pipeboard Meta Ads MCP · {zh ? '只读 · 读取于' : 'Read only · Read at'} {new Date(summary.readAt).toLocaleString()} · {zh ? '日期按本机日历；账户时区' : 'Dates use this computer’s calendar; account timezone'}: {summary.account.timezone ?? (zh ? '待确认' : 'unverified')}</p>
  </article>
}
