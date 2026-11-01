import {
  fbReadingMatchesWindow,
  type FbReadingAccountEntry,
  type FbReadingHistoryEntry
} from '@shared/fbReading'
import {
  fbPresetForTodayRange,
  previousEqualWindow,
  todayWindow,
  topSpendMoves,
  type TodayCampaignMove,
  type TodayRange,
  type TodayWindow
} from '@shared/todayReading'

/** A single failed history request must never turn into an empty account list. */
export interface TodayFacebookRow {
  account: FbReadingAccountEntry
  covered: boolean
  readError: 'history-read-failed' | null
  spend: number | null
  previousSpend: number | null
  currency: string | null
  impressions: number | null
  clicks: number | null
  conversions: number | null
  resultType: string | null
  costPerResult: number | null
  capturedAt: string | null
  movers: TodayCampaignMove[]
}

/** The runtime history may contain an observation even on older shared types. */
function verifiedCurrency(entry: FbReadingHistoryEntry | null): string | null {
  const observation = (entry as (FbReadingHistoryEntry & { observation?: { currency?: unknown } }) | null)?.observation
  const currency = typeof observation?.currency === 'string' ? observation.currency.trim() : ''
  return /^[A-Z]{3}$/.test(currency) ? currency : null
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function completeSum(values: Array<number | null | undefined>): number | null {
  if (!values.length || values.some((value) => finiteNonNegative(value) === null)) return null
  const sum = values.reduce<number>((total, value) => total + (value as number), 0)
  return Number.isFinite(sum) ? sum : null
}

function completeRows(entry: FbReadingHistoryEntry | null): boolean {
  return !!entry && Array.isArray(entry.rows) && entry.rows.length > 0 && entry.campaignCount === entry.rows.length
}

function uniqueCampaignNames(entry: FbReadingHistoryEntry | null): boolean {
  if (!entry) return false
  const names = entry.rows.map((row) => row.name.trim())
  return names.every(Boolean) && new Set(names).size === names.length
}

function blankRow(account: FbReadingAccountEntry, covered: boolean, readError: TodayFacebookRow['readError'] = null): TodayFacebookRow {
  return { account, covered, readError, spend: null, previousSpend: null, currency: null, impressions: null, clicks: null, conversions: null, resultType: null, costPerResult: null, capturedAt: null, movers: [] }
}

/** Preserve unknown and mixed result types rather than inventing a combined CPA. */
export function facebookRowFromEntry(account: FbReadingAccountEntry, current: FbReadingHistoryEntry | null, prior: FbReadingHistoryEntry | null): TodayFacebookRow {
  if (!current) return blankRow(account, true)
  const rows = current.rows ?? []
  const complete = completeRows(current)
  const currency = verifiedCurrency(current)
  const priorCurrency = verifiedCurrency(prior)
  const comparable = !!currency && currency === priorCurrency && completeRows(prior)
  const spend = finiteNonNegative(current.totalSpend)
  const types = rows.map((row) => typeof row.resultType === 'string' ? row.resultType.trim() : '')
  const resultType = complete && types.every(Boolean) && new Set(types).size === 1 ? types[0] : null
  const conversions = complete && resultType ? completeSum(rows.map((row) => row.results)) : null
  const costPerResult = spend !== null && conversions !== null && conversions > 0 ? spend / conversions : null
  const currentSpendComplete = complete && uniqueCampaignNames(current) && completeSum(rows.map((row) => row.spend)) !== null
  const priorSpendComplete = comparable && uniqueCampaignNames(prior) && completeSum((prior?.rows ?? []).map((row) => row.spend)) !== null
  const movers = currentSpendComplete
    ? topSpendMoves(rows.map((row) => ({ name: row.name, spend: row.spend as number })),
      priorSpendComplete ? prior!.rows.map((row) => ({ name: row.name, spend: row.spend as number })) : null, 3)
    : []
  return {
    account, covered: true, readError: null, spend, currency,
    previousSpend: comparable ? finiteNonNegative(prior?.totalSpend) : null,
    impressions: complete ? completeSum(rows.map((row) => row.impressions)) : null,
    clicks: complete ? completeSum(rows.map((row) => row.clicks)) : null,
    conversions, resultType, costPerResult: costPerResult !== null && Number.isFinite(costPerResult) ? costPerResult : null,
    capturedAt: current.capturedAt, movers
  }
}

/** List each account independently; the outer account-list request remains the caller's responsibility. */
export async function loadTodayFacebookAccounts(
  accounts: FbReadingAccountEntry[],
  range: TodayRange,
  loadHistory: (accountId: string) => Promise<FbReadingHistoryEntry[]>,
  now: Date = new Date(),
  explicitWindow?: TodayWindow
): Promise<TodayFacebookRow[]> {
  const currentWindow = explicitWindow ?? todayWindow(range, now)
  const previousWindow = previousEqualWindow(currentWindow)
  if ((!explicitWindow && !fbPresetForTodayRange(range)) || !previousWindow) return accounts.map((account) => blankRow(account, false))
  return Promise.all(accounts.map(async (account) => {
    try {
      const entries = await loadHistory(account.act)
      if (!Array.isArray(entries)) throw new Error('history-unavailable')
      const current = entries.find((entry) => fbReadingMatchesWindow(entry, account.act, currentWindow)) ?? null
      const prior = entries.find((entry) => fbReadingMatchesWindow(entry, account.act, previousWindow)) ?? null
      return facebookRowFromEntry(account, current, prior)
    } catch {
      return blankRow(account, true, 'history-read-failed')
    }
  }))
}
