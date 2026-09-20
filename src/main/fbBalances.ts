import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { FbAccountBalance } from '../shared/fbBillingParser'

export interface FbAccountBalanceEntry extends FbAccountBalance {
  id: string
}

const MAX_BALANCE_ENTRIES = 100

/** Keep one newest verified balance per ad account, bounded and local-only. */
export function normalizeFbAccountBalances(raw: unknown): FbAccountBalanceEntry[] {
  if (!Array.isArray(raw)) return []
  const byAccount = new Map<string, FbAccountBalanceEntry>()
  for (const item of raw) {
    const entry = validateEntry(item)
    if (!entry) continue
    const prev = byAccount.get(entry.accountId)
    if (!prev || prev.capturedAt.localeCompare(entry.capturedAt) <= 0) byAccount.set(entry.accountId, entry)
  }
  return Array.from(byAccount.values())
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
    .slice(-MAX_BALANCE_ENTRIES)
}

function validateEntry(value: unknown): FbAccountBalanceEntry | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id || v.id.length > 100) return null
  if (typeof v.capturedAt !== 'string' || Number.isNaN(Date.parse(v.capturedAt))) return null
  if (!/^\d{6,20}$/.test(String(v.accountId))) return null
  if (typeof v.amount !== 'number' || !Number.isFinite(v.amount)) return null
  if (v.kind !== 'available' && v.kind !== 'due') return null
  if (typeof v.amountText !== 'string' || !v.amountText || v.amountText.length > 40) return null
  if (typeof v.label !== 'string' || !v.label || v.label.length > 60) return null
  if (v.currency !== null && typeof v.currency !== 'string') return null
  if (v.sourceUrl !== null && typeof v.sourceUrl !== 'string') return null
  if (typeof v.sourceUrl === 'string' && v.sourceUrl.length > 2048) return null
  return value as FbAccountBalanceEntry
}

function balancesFile(): string {
  return path.join(app.getPath('userData'), 'fb-account-balances.json')
}

function readBalances(file: string): FbAccountBalanceEntry[] {
  try {
    return normalizeFbAccountBalances(JSON.parse(readFileSync(file, 'utf-8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Could not read the FB account balance store.')
  }
}

function writeBalances(file: string, entries: FbAccountBalanceEntry[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

export function listFbAccountBalances(accountId?: string): FbAccountBalanceEntry[] {
  const entries = readBalances(balancesFile()).reverse()
  return accountId === undefined ? entries : entries.filter((entry) => entry.accountId === accountId)
}

export function saveFbAccountBalance(balance: FbAccountBalance): FbAccountBalanceEntry {
  const entry: FbAccountBalanceEntry = { id: randomUUID(), ...balance }
  const file = balancesFile()
  const existing = readBalances(file).filter((item) => item.accountId !== balance.accountId)
  writeBalances(file, normalizeFbAccountBalances([...existing, entry]))
  return entry
}
