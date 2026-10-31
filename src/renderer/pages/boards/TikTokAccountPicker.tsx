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
  retry: string
  invalidId: string
  readOne: string
  readAll: string
  readAllHint: string
}

export interface TikTokAccountPickerProps {
  labels: TikTokAccountPickerLabels
  busy?: boolean
  /** Reads this account once; does not change the connection's saved selection. */
  onReadOne: (advertiserId: string) => void
  /** Uses the existing connection selection, or its authorized grant when none is selected. */
  onReadAll: () => void
  /** Injection seam for isolated tests; production only discovers through Main. */
  discover?: () => Promise<TikTokReadingAdvertisers>
}

const ID = /^[1-9]\d{0,24}$/

/** Validate provider output without silently dropping malformed account IDs. */
export async function discoverPickerAccounts(discover: () => Promise<TikTokReadingAdvertisers>): Promise<string[]> {
  const result = await discover()
  if (!result || !Array.isArray(result.granted) || result.granted.length > 500 || result.granted.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error('invalid-account-discovery')
  return [...new Set(result.granted)]
}

/** Returns null for a malformed entry; the backend still verifies authorization. */
export function parsePickerAccount(value: string): string | null {
  const id = value.trim()
  return ID.test(id) ? id : null
}

/** Explicit choice between one account and the existing connection scope. */
export function TikTokAccountPicker({ labels, busy = false, onReadOne, onReadAll, discover }: TikTokAccountPickerProps) {
  const listId = useId()
  const [ids, setIds] = useState<string[]>([])
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
      setIds(found)
      setStatus('ready')
    } catch {
      if (generation.current !== current) return
      setIds([])
      setStatus('error')
    }
  }, [])
  useEffect(() => {
    void load()
    return () => { generation.current += 1 }
  }, [load])

  const accountId = parsePickerAccount(draft)
  const invalid = draft.trim().length > 0 && accountId === null
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
        <input
          id={`${listId}-account`}
          list={`${listId}-accounts`}
          inputMode="numeric"
          autoComplete="off"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder={labels.accountPlaceholder}
          aria-invalid={invalid}
          aria-describedby={`${listId}-hint${invalid ? ` ${listId}-invalid` : ''}`}
          disabled={busy}
          className="w-full rounded-lg border border-line bg-ink-850 px-3 py-2 text-[12px] text-cream outline-none focus:border-accent/60 disabled:opacity-50"
        />
        <datalist id={`${listId}-accounts`}>{ids.map(id => <option key={id} value={id} />)}</datalist>
        <p id={`${listId}-hint`} className="text-[12px] leading-5 text-cream-faint">{labels.manualHint}</p>
        {invalid && <p id={`${listId}-invalid`} role="alert" className="text-[12px] text-red-500">{labels.invalidId}</p>}
        {status === 'loading' && <p role="status" className="text-[12px] text-cream-faint">{labels.loading}</p>}
        {status === 'ready' && ids.length === 0 && <p role="status" className="text-[12px] text-cream-faint">{labels.empty}</p>}
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
