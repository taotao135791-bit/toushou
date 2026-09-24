import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  FB_READING_BUILTIN_ACCOUNTS,
  FB_READING_ACCOUNT_MAX,
  FbReadingAccountEntry,
  FbReadingAccountRef,
  isValidFbReadingAct,
  isValidFbReadingBusinessId
} from '../shared/fbReading'

/**
 * Local FB-reading account registry (userData/fb-reading-accounts.json).
 * Colleagues manage their own ad accounts here; nothing leaves the machine.
 * Builtin accounts are seeded on first run so legacy boards keep working.
 */
export type { FbReadingAccountEntry }

export const FB_READING_ACCOUNT_LIMITS = {
  maxAccounts: FB_READING_ACCOUNT_MAX,
  maxAliasLength: 40
} as const

function builtinEntries(now: number): FbReadingAccountEntry[] {
  return FB_READING_BUILTIN_ACCOUNTS.map((ref) => ({ ...ref, id: randomUUID(), createdAt: now }))
}

/** Pure parse+validate for the persisted document (test-friendly). */
export function parseFbReadingAccounts(json: string): FbReadingAccountEntry[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const entries: FbReadingAccountEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    const alias = typeof candidate.alias === 'string' ? candidate.alias.trim() : ''
    if (!alias || alias.length > FB_READING_ACCOUNT_LIMITS.maxAliasLength) continue
    if (!isValidFbReadingAct(candidate.act)) continue
    if (!isValidFbReadingBusinessId(candidate.businessId ?? null)) continue
    if (typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 64) continue
    if (typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)) continue
    if (entries.some((entry) => entry.act === candidate.act || entry.id === candidate.id)) continue
    entries.push({
      id: candidate.id,
      alias,
      act: candidate.act,
      businessId: (candidate.businessId as string | null) ?? null,
      createdAt: candidate.createdAt
    })
  }
  return entries.slice(0, FB_READING_ACCOUNT_LIMITS.maxAccounts)
}

/** Pure merge that dedupes by act; returns the next list and the added refs. */
export function mergeFbReadingAccounts(
  prev: FbReadingAccountEntry[],
  refs: FbReadingAccountRef[],
  now: number = Date.now()
): { accounts: FbReadingAccountEntry[]; added: FbReadingAccountRef[] } {
  const next = [...prev]
  const added: FbReadingAccountRef[] = []
  for (const ref of refs) {
    if (next.length >= FB_READING_ACCOUNT_LIMITS.maxAccounts) break
    const alias = ref.alias.trim()
    if (!alias || alias.length > FB_READING_ACCOUNT_LIMITS.maxAliasLength) continue
    if (!isValidFbReadingAct(ref.act)) continue
    if (!isValidFbReadingBusinessId(ref.businessId)) continue
    if (next.some((entry) => entry.act === ref.act)) continue
    const entry = { id: randomUUID(), alias, act: ref.act, businessId: ref.businessId, createdAt: now }
    next.push(entry)
    added.push({ alias, act: ref.act, businessId: ref.businessId })
  }
  return { accounts: next, added }
}

function accountsPath(): string {
  return path.join(app.getPath('userData'), 'fb-reading-accounts.json')
}

function writeAccounts(entries: FbReadingAccountEntry[]): void {
  const file = accountsPath()
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

export function listFbReadingAccounts(): FbReadingAccountEntry[] {
  try {
    const entries = parseFbReadingAccounts(readFileSync(accountsPath(), 'utf-8'))
    if (entries.length > 0 || FB_READING_BUILTIN_ACCOUNTS.length === 0) return entries
    // First run with an empty document: seed builtins once.
    const seeded = builtinEntries(Date.now())
    writeAccounts(seeded)
    return seeded
  } catch {
    // Missing or unreadable file → seed builtins.
    const seeded = builtinEntries(Date.now())
    try {
      writeAccounts(seeded)
    } catch {
      // Read-only environment: return the seed without persisting.
    }
    return seeded
  }
}

export function appendFbReadingAccounts(refs: FbReadingAccountRef[]): {
  accounts: FbReadingAccountEntry[]
  added: FbReadingAccountRef[]
} {
  const merged = mergeFbReadingAccounts(listFbReadingAccounts(), refs)
  if (merged.added.length > 0) writeAccounts(merged.accounts)
  return merged
}

export function removeFbReadingAccount(id: string): FbReadingAccountEntry[] {
  const next = listFbReadingAccounts().filter((entry) => entry.id !== id)
  writeAccounts(next)
  return next
}
