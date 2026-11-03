import { useId, useState } from 'react'
import type { FbReadingAccountEntry } from '@shared/fbReading'
import { FbReadingAccountManager } from './FbReadingAccountManager'

export function FacebookAccountPicker({ accounts, busy, loading, error, zh, needsBrowser, onRead, onReload, onOpenBrowser }: {
  accounts: FbReadingAccountEntry[]
  busy: boolean
  loading: boolean
  error: boolean
  zh: boolean
  needsBrowser: boolean
  onRead: (acts: string[]) => void
  onReload: () => void
  onOpenBrowser: () => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [manage, setManage] = useState(false)
  const matches = accounts.filter(account => `${account.alias} ${account.act}`.toLowerCase().includes(query.trim().toLowerCase()))
  const button = 'focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim disabled:opacity-40'
  return <section className="space-y-3 rounded-xl border border-line p-4" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="text-[14px] font-medium text-cream">{zh ? '选择 Facebook 读取范围' : 'Choose Facebook reading scope'}</h3>
    <p className="text-[12px] leading-5 text-cream-faint">{zh ? '先选择一个账户，或主动巡检全部已添加账户。读取结果通过校验后可保存为看板或交给 AI 分析。' : 'Choose one account or inspect all added accounts. Verified results can be saved to a board or analyzed with AI.'}</p>
    <label htmlFor={`${id}-query`} className="block text-[12px] text-cream-dim">{zh ? '账户名称或广告账户 ID' : 'Account name or ad account ID'}</label>
    <input id={`${id}-query`} type="search" value={query} onChange={e => { setQuery(e.target.value); setSelected('') }} disabled={busy} placeholder={zh ? '按名称或 ID 搜索已添加账户' : 'Search added accounts by name or ID'} className="focus-ring w-full rounded-lg border border-line bg-ink-850 px-3 py-2 text-[13px] text-cream placeholder:text-cream-faint disabled:opacity-40" />
    {loading ? <p role="status" className="text-[12px] text-cream-faint">{zh ? '正在加载账户…' : 'Loading accounts…'}</p> : error ? <p role="alert" className="text-[12px] text-red-600">{zh ? '账户或历史读数加载失败，请重试。' : 'Could not load accounts or history. Retry.'}</p> : <>
      {accounts.length === 0 ? <p className="text-[12px] text-cream-faint">{zh ? '还没有添加账户。打开浏览器登录 Facebook，再通过「管理账户」发现或添加。' : 'No accounts added. Sign in to Facebook in the browser, then discover or add accounts under Manage accounts.'}</p> : matches.length === 0 ? <p className="text-[12px] text-cream-faint">{zh ? '没有匹配账户，可在「管理账户」中添加。' : 'No matching accounts. Add one under Manage accounts.'}</p> : <fieldset disabled={busy} className="max-h-48 space-y-1 overflow-y-auto" aria-label={zh ? 'Facebook 账户' : 'Facebook accounts'}>
        {matches.map(account => <label key={account.act} className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${selected === account.act ? 'bg-overlay' : 'hover:bg-overlay'}`}>
          <input type="radio" className="accent-accent" name={`${id}-account`} value={account.act} checked={selected === account.act} onChange={() => setSelected(account.act)} />
          <span className="min-w-0"><span className="block truncate text-[13px] text-cream" title={account.alias}>{account.alias}</span><span className="block text-[11px] text-cream-faint">ID {account.act}</span></span>
        </label>)}
      </fieldset>}
    </>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={onOpenBrowser} disabled={busy} className={button}>{zh ? '打开浏览器' : 'Open browser'}</button>
      <button type="button" onClick={onReload} disabled={busy || loading} className={button}>{zh ? '重新加载账户' : 'Reload accounts'}</button>
      <button type="button" onClick={() => setManage(!manage)} disabled={busy || loading} aria-expanded={manage} className={button}>{zh ? '管理账户' : 'Manage accounts'}</button>
    </div>
    {manage && <fieldset disabled={busy}><FbReadingAccountManager open accounts={accounts} onAccountsChange={onReload} /></fieldset>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => onRead([selected])} disabled={busy || loading || error || needsBrowser || !accounts.some(account => account.act === selected)} className="focus-ring rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-[rgb(var(--bg-app))] disabled:opacity-40">{zh ? '读取此账户' : 'Read this account'}</button>
      <button type="button" onClick={() => onRead(accounts.map(account => account.act))} disabled={busy || loading || error || needsBrowser || !accounts.length} className={button}>{zh ? `巡检全部已添加账户（${accounts.length}）` : `Inspect all added accounts (${accounts.length})`}</button>
    </div>
    <p className="text-[12px] leading-5 text-cream-faint">{needsBrowser ? (zh ? '请先打开浏览器并登录 Facebook，再返回读取。' : 'Open the browser and sign in to Facebook before reading.') : (zh ? '通过已登录的浏览器逐账户只读获取；不会修改广告。搜索只筛选列表，全量巡检仍包含全部已添加账户。' : 'Read-only access through your signed-in browser, one account at a time. Search filters this list; inspection still includes all added accounts.')}</p>
  </section>
}
