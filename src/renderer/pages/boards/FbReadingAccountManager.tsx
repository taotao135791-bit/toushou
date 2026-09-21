import { useEffect, useState } from 'react'
import type { FbReadingAccountEntry } from '@shared/fbReading'
import { useT } from '../../i18n'
import { useAppStore } from '../../store'

interface FbReadingAccountManagerProps {
  open: boolean
  accounts: FbReadingAccountEntry[]
  onAccountsChange: (accounts: FbReadingAccountEntry[]) => void
  onAccountsAdded?: (accounts: FbReadingAccountEntry[]) => void
  onAccountsRemoved?: (acts: string[]) => void
  /** Pickers already render selectable rows; hide the duplicate registry list there. */
  showAccounts?: boolean
}

const inputClass =
  'w-full rounded-lg border border-line bg-ink-850 px-2 py-1 text-[12px] text-cream outline-none transition placeholder:text-cream-faint focus:border-accent/50'

/**
 * Shared FB account registry UI. Main remains the only owner of the
 * discovery/capture/add/remove IPC and validation; widget config and the
 * multi-account picker reuse this component without an AI request.
 */
export function FbReadingAccountManager({
  open,
  accounts,
  onAccountsChange,
  onAccountsAdded,
  onAccountsRemoved,
  showAccounts = true
}: FbReadingAccountManagerProps) {
  const t = useT()
  const inChat = useAppStore((s) => s.workspacePanel) === null
  const [loading, setLoading] = useState(true)
  const [formAlias, setFormAlias] = useState('')
  const [formAct, setFormAct] = useState('')
  const [formBusinessId, setFormBusinessId] = useState('')
  const [accountError, setAccountError] = useState<'invalid' | null>(null)
  const [accountBusy, setAccountBusy] = useState(false)
  const [discoverQuery, setDiscoverQuery] = useState('')
  const [discoverBusy, setDiscoverBusy] = useState(false)
  const [discovered, setDiscovered] = useState<Array<{ name: string; act: string }> | null>(null)
  const [discoveredRanked, setDiscoveredRanked] = useState(false)
  const [discoverFailed, setDiscoverFailed] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.electronAPI
      .listFbReadingAccounts()
      .then((list) => {
        if (alive) onAccountsChange(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (alive) onAccountsChange([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // Mount-time hydration only. Parent callbacks are intentionally excluded
    // to avoid turning every state update into a registry reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addAccount = async () => {
    const alias = formAlias.trim()
    const act = formAct.trim()
    const businessId = formBusinessId.trim()
    if (!alias || !/^\d{6,20}$/.test(act) || (businessId !== '' && !/^\d{6,20}$/.test(businessId))) {
      setAccountError('invalid')
      return
    }
    setAccountBusy(true)
    setAccountError(null)
    try {
      const result = await window.electronAPI.addFbReadingAccounts({
        accounts: [{ alias, act, businessId: businessId === '' ? null : businessId }]
      })
      if (!result.ok || !result.accounts) {
        setAccountError('invalid')
        return
      }
      onAccountsChange(result.accounts)
      onAccountsAdded?.(result.accounts.filter((entry) => entry.act === act))
      setFormAlias('')
      setFormAct('')
      setFormBusinessId('')
    } catch {
      setAccountError('invalid')
    } finally {
      setAccountBusy(false)
    }
  }

  const addDiscovered = async (entry: { name: string; act: string }) => {
    if (accounts.some((account) => account.act === entry.act)) return
    setAccountBusy(true)
    try {
      const result = await window.electronAPI.addFbReadingAccounts({
        accounts: [{ alias: entry.name, act: entry.act, businessId: null }]
      })
      if (result.ok && result.accounts) {
        onAccountsChange(result.accounts)
        onAccountsAdded?.(result.accounts.filter((account) => account.act === entry.act))
      }
    } catch {
      // Keep the discovered list; the user can retry or add manually.
    } finally {
      setAccountBusy(false)
    }
  }

  const removeAccount = async (id: string) => {
    const removed = accounts.filter((account) => account.id === id).map((account) => account.act)
    try {
      const result = await window.electronAPI.removeFbReadingAccount({ id })
      if (result.ok && result.accounts) {
        onAccountsChange(result.accounts)
        onAccountsRemoved?.(removed)
      }
    } catch {
      // Main remains the source of truth; it is re-read on the next mount.
    }
  }

  const discover = async () => {
    setDiscoverBusy(true)
    setDiscovered(null)
    setDiscoverFailed(false)
    setDiscoverError(null)
    try {
      const result = await window.electronAPI.discoverFbReadingAccounts({ query: discoverQuery.trim() })
      if (result.ok) {
        setDiscovered(result.accounts ?? [])
        setDiscoveredRanked(result.ranked === true)
      } else {
        setDiscoverFailed(true)
        setDiscoverError(result.error ?? 'unknown')
      }
    } catch {
      setDiscoverFailed(true)
      setDiscoverError('invoke-failed')
    } finally {
      setDiscoverBusy(false)
    }
  }

  const captureFromPanel = async () => {
    setDiscoverFailed(false)
    setDiscoverError(null)
    try {
      const result = await window.electronAPI.captureFbReadingAccount()
      if (!result.ok || !result.account) {
        setDiscoverFailed(true)
        setDiscoverError(result.error ?? 'unknown')
        return
      }
      setFormAct(result.account.act)
      setFormBusinessId(result.account.businessId ?? '')
    } catch {
      setDiscoverFailed(true)
      setDiscoverError('invoke-failed')
    }
  }

  if (!open) return null

  return (
    <div className="space-y-2 rounded-xl border border-line bg-ink-850/60 p-2">
      {showAccounts && (
        <div className="space-y-1">
          {loading && <div className="text-[11px] text-cream-faint">{t('boards.reading.accounts.loading')}</div>}
          {!loading && accounts.length === 0 && (
            <div className="text-[11px] text-cream-faint">{t('boards.reading.picker.noneDirect')}</div>
          )}
          {accounts.map((entry) => (
            <div key={entry.id} className="flex items-center justify-between gap-2 text-[11px] text-cream-dim">
              <span className="truncate">{entry.alias} · {entry.act}</span>
              <button
                type="button"
                onClick={() => void removeAccount(entry.id)}
                className="shrink-0 text-cream-faint transition hover:text-red-400"
              >
                {t('boards.reading.accounts.remove')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5 border-t border-line pt-2">
        <input
          value={discoverQuery}
          onChange={(e) => setDiscoverQuery(e.target.value)}
          maxLength={30}
          placeholder={t('boards.reading.accounts.query')}
          className={inputClass}
        />
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => void discover()}
            disabled={discoverBusy || inChat}
            title={inChat ? t('boards.reading.inChat') : undefined}
            className="rounded-lg border border-line px-2 py-1 text-[11px] text-cream-dim transition hover:text-cream disabled:opacity-40"
          >
            {discoverBusy ? t('boards.reading.accounts.discovering') : t('boards.reading.accounts.discover')}
          </button>
          <button
            type="button"
            onClick={() => void captureFromPanel()}
            disabled={inChat}
            title={inChat ? t('boards.reading.inChat') : undefined}
            className="rounded-lg border border-accent/50 px-2 py-1 text-[11px] text-accent transition hover:opacity-80"
          >
            {t('boards.reading.accounts.capture')}
          </button>
        </div>
        {discoverFailed && (
          <div className="text-[11px] text-red-400">
            {t('boards.reading.accounts.discoverFailed')} ({discoverError ?? 'unknown'})
          </div>
        )}
        {discovered && discovered.length === 0 && (
          <div className="text-[11px] text-cream-faint">{t('boards.reading.accounts.discoveredNone')}</div>
        )}
        {discovered && discovered.length > 0 && discoveredRanked && (
          <div className="text-[11px] text-cream-faint">{t('boards.reading.accounts.ranked')}</div>
        )}
        {discovered && discovered.length > 0 && (
          <div className="max-h-[120px] space-y-0.5 overflow-y-auto">
            {discovered.map((entry) => {
              const exists = accounts.some((account) => account.act === entry.act)
              return (
                <div key={entry.act} className="flex items-center justify-between gap-2 text-[11px] text-cream-dim">
                  <span className="truncate">{entry.name} · {entry.act}</span>
                  <button
                    type="button"
                    onClick={() => void addDiscovered(entry)}
                    disabled={exists || accountBusy}
                    className="shrink-0 text-accent transition hover:opacity-80 disabled:opacity-40"
                  >
                    {exists ? t('boards.reading.accounts.exists') : t('boards.reading.accounts.addShort')}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <input
          value={formAlias}
          onChange={(e) => setFormAlias(e.target.value)}
          maxLength={40}
          placeholder={t('boards.reading.accounts.alias')}
          className={inputClass}
        />
        <input
          value={formAct}
          onChange={(e) => setFormAct(e.target.value)}
          inputMode="numeric"
          placeholder={t('boards.reading.accounts.act')}
          className={inputClass}
        />
        <input
          value={formBusinessId}
          onChange={(e) => setFormBusinessId(e.target.value)}
          inputMode="numeric"
          placeholder={t('boards.reading.accounts.businessId')}
          className={inputClass}
        />
        {accountError === 'invalid' && (
          <div className="text-[11px] text-red-400">{t('boards.reading.accounts.invalid')}</div>
        )}
        <button
          type="button"
          onClick={() => void addAccount()}
          disabled={accountBusy}
          className="w-full rounded-lg border border-accent/50 bg-accent-soft px-2 py-1 text-[11px] text-accent transition hover:opacity-80 disabled:opacity-40"
        >
          {t('boards.reading.accounts.add')}
        </button>
      </div>
    </div>
  )
}
