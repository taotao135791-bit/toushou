import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { TikTokReadingAdvertisers } from '@shared/tiktokReport'

export interface TikTokAccountPickerLabels {
  title: string
  description: string
  accountLabel: string
  accountPlaceholder: string
  manualHint: string
  loading: string
  empty: string
  discoveryError: string
  namesIncomplete: string
  noMatch: string
  retry: string
  invalidId: string
  readOne: string
  readAll: string
  readAllHint: string
}

export interface TikTokAccountPickerProps {
  labels: TikTokAccountPickerLabels
  busy?: boolean
  onReadOne: (advertiserId: string) => void
  onReadAll: () => void
  discover?: () => Promise<TikTokReadingAdvertisers>
}

export interface PickerAccount { advertiserId: string; name: string | null }
export interface PickerDiscovery { accounts: PickerAccount[]; namesIncomplete: boolean }
const ID = /^[1-9]\d{0,24}$/

/** The grant is authoritative; account names are optional display-only metadata. */
export async function discoverPickerAccounts(discover: () => Promise<TikTokReadingAdvertisers>): Promise<PickerDiscovery> {
  const result = await discover()
  if (!result || !Array.isArray(result.granted) || result.granted.length > 500 || result.granted.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error('invalid-account-discovery')
  const granted = [...new Set(result.granted)]
  const allowed = new Set(granted)
  const names = new Map<string, string | null>()
  const conflicts = new Set<string>()
  const records = Array.isArray(result.accounts) ? result.accounts : []
  for (const account of records) {
    if (!account || typeof account.advertiserId !== 'string' || !allowed.has(account.advertiserId)) continue
    const value = typeof account.name === 'string' ? account.name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120) : ''
    const name = value || null
    if (names.has(account.advertiserId) && names.get(account.advertiserId) !== name) conflicts.add(account.advertiserId)
    else names.set(account.advertiserId, name)
  }
  const accounts = granted.map((advertiserId) => ({ advertiserId, name: conflicts.has(advertiserId) ? null : names.get(advertiserId) ?? null }))
  return { accounts, namesIncomplete: result.namesIncomplete === true || accounts.some((account) => account.name === null) }
}

export function filterPickerAccounts(accounts: PickerAccount[], query: string): PickerAccount[] {
  const search = query.trim().toLowerCase()
  return search ? accounts.filter((account) => account.advertiserId.includes(search) || account.name?.toLowerCase().includes(search)) : accounts
}

/** Typed text never resolves to an account by ambiguous name. */
export function parsePickerAccount(value: string): string | null {
  const id = value.trim()
  return ID.test(id) ? id : null
}

export function TikTokAccountOptions({ accounts, selectedId, busy, onSelect }: { accounts: PickerAccount[]; selectedId: string | null; busy: boolean; onSelect: (id: string) => void }) {
  return <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-1">
    {accounts.map((account) => <button key={account.advertiserId} type="button" onClick={() => onSelect(account.advertiserId)} disabled={busy} aria-pressed={account.advertiserId === selectedId} className="flex w-full flex-wrap items-center justify-between gap-x-3 rounded-md px-2 py-1.5 text-left text-[12px] text-cream-dim hover:bg-overlay disabled:opacity-40">
      <span className="min-w-0 truncate font-medium text-cream">{account.name ?? account.advertiserId}</span>
      {account.name && <span className="font-mono text-cream-faint">{account.advertiserId}</span>}
    </button>)}
  </div>
}

export function TikTokAccountPicker({ labels, busy = false, onReadOne, onReadAll, discover }: TikTokAccountPickerProps) {
  const listId = useId()
  const [accounts, setAccounts] = useState<PickerAccount[]>([])
  const [namesIncomplete, setNamesIncomplete] = useState(false)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const generation = useRef(0)
  const discoverRef = useRef(discover)
  discoverRef.current = discover
  const load = useCallback(async () => {
    const current = ++generation.current
    setStatus('loading')
    try {
      const found = await discoverPickerAccounts(() => discoverRef.current ? discoverRef.current() : window.electronAPI.ttReadingAdvertisers())
      if (generation.current !== current) return
      setAccounts(found.accounts)
      setNamesIncomplete(found.namesIncomplete)
      setStatus('ready')
    } catch {
      if (generation.current !== current) return
      setAccounts([])
      setNamesIncomplete(false)
      setStatus('error')
    }
  }, [])
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])

  const accountId = parsePickerAccount(draft)
  const invalid = draft.trim().length > 0 && /^\d+$/.test(draft.trim()) && accountId === null
  const matches = filterPickerAccounts(accounts, draft)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && accountId) onReadOne(accountId)
  }
  return (
    <section aria-label={labels.title} className="rounded-xl border border-line bg-ink-900 p-4">
      <h3 className="text-[14px] font-medium text-cream">{labels.title}</h3>
      <p className="mt-1 text-[12px] leading-5 text-cream-faint">{labels.description}</p>
      <form onSubmit={submit} className="mt-3 space-y-2">
        <label htmlFor={`${listId}-account`} className="block text-[12px] text-cream-dim">{labels.accountLabel}</label>
        <input id={`${listId}-account`} type="search" autoComplete="off" value={draft} onChange={event => setDraft(event.target.value)} placeholder={labels.accountPlaceholder} aria-invalid={invalid} aria-describedby={`${listId}-hint${invalid ? ` ${listId}-invalid` : ''}`} disabled={busy} className="w-full rounded-lg border border-line bg-ink-850 px-3 py-2 text-[12px] text-cream outline-none focus:border-accent/60 disabled:opacity-50" />
        {status === 'ready' && matches.length > 0 && <TikTokAccountOptions accounts={matches} selectedId={accountId} busy={busy} onSelect={setDraft} />}
        {status === 'ready' && accounts.length > 0 && matches.length === 0 && <p role="status" className="text-[12px] text-cream-faint">{labels.noMatch}</p>}
        <p id={`${listId}-hint`} className="text-[12px] leading-5 text-cream-faint">{labels.manualHint}</p>
        {invalid && <p id={`${listId}-invalid`} role="alert" className="text-[12px] text-red-500">{labels.invalidId}</p>}
        {status === 'loading' && <p role="status" className="text-[12px] text-cream-faint">{labels.loading}</p>}
        {status === 'ready' && accounts.length === 0 && <p role="status" className="text-[12px] text-cream-faint">{labels.empty}</p>}
        {status === 'ready' && namesIncomplete && <p role="status" className="text-[12px] text-amber-700 dark:text-amber-300">{labels.namesIncomplete}</p>}
        {status === 'error' && <p role="alert" className="text-[12px] text-red-500">{labels.discoveryError}</p>}
        {status !== 'loading' && <button type="button" onClick={() => void load()} className="focus-ring rounded-full border border-line px-3 py-1 text-[12px] text-cream-dim">{labels.retry}</button>}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="submit" disabled={busy || !accountId} className="focus-ring rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-40">{labels.readOne}</button>
          <button type="button" onClick={() => { if (!busy) onReadAll() }} disabled={busy} className="focus-ring rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim disabled:opacity-40">{labels.readAll}</button>
        </div>
        <p className="text-[12px] leading-5 text-cream-faint">{labels.readAllHint}</p>
      </form>
    </section>
  )
}
