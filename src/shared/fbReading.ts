import type { FbAccountBalance } from './fbBillingParser'

/**
 * FB reading targets and URL grammar, shared by the renderer (prompt
 * building) and Main (refresh IPC): the same canonical URL drives both the
 * conversational path and the direct panel refresh.
 *
 * Ads Manager URL grammar: date and insights_date MUST be paired with the
 * same <start>_<exclusive-end> value. Do not invent preset tokens: last_3d
 * crashes the current Ads Manager component (reproduced 2026-09-17).
 * "last N days" excludes today (verified 2026-09-16).
 */

export type FbReadingRange = 'today' | 'last3' | 'last7' | 'last30'
export const FB_READING_ACCOUNT_MAX = 50

/**
 * Account reference used by the local registry and snapshotted into widget
 * configs. Configs keep act/businessId so a module keeps working even if the
 * alias is later renamed or removed from the registry.
 */
export interface FbReadingAccountRef {
  alias: string
  act: string
  businessId: string | null
}

/** One row of the local account registry file (main-owned storage). */
export interface FbReadingAccountEntry extends FbReadingAccountRef {
  id: string
  createdAt: number
}

export interface FbReadingDiscoveredAccount {
  name: string
  act: string
}

/** A successful scan may be explicitly partial when a defensive scan limit is hit. */
export type FbReadingAccountDiscoveryResult =
  | { ok: true; accounts: FbReadingDiscoveredAccount[]; complete: boolean }
  | { ok: false; error: string }

export type FbReadingAccountsAddResult =
  | { ok: true; accounts: FbReadingAccountEntry[]; added: FbReadingAccountRef[] }
  | { ok: false; accounts?: FbReadingAccountEntry[]; error: string }

/** Accounts seeded on first run so legacy 三国IOS boards keep working. */
export const FB_READING_BUILTIN_ACCOUNTS: FbReadingAccountRef[] = [
  { alias: '三国IOS', act: '2131017261144314', businessId: '1734414010144999' }
]

export function isValidFbReadingAct(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6,20}$/.test(value)
}

export function isValidFbReadingBusinessId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{6,20}$/.test(value))
}

/** Resolve a widget config into an account ref; legacy aliases fall back to builtins. */
export function resolveFbReadingWidgetAccount(config: Record<string, unknown>): FbReadingAccountRef | null {
  const alias = typeof config.account === 'string' ? config.account.trim() : ''
  if (!alias) return null
  if (isValidFbReadingAct(config.act)) {
    return {
      alias,
      act: config.act,
      businessId: isValidFbReadingBusinessId(config.businessId) ? config.businessId : null
    }
  }
  const builtin = FB_READING_ACCOUNT_TARGETS[alias]
  return builtin ? { alias, act: builtin.act, businessId: builtin.businessId } : null
}

/** Resolve the account list snapshotted into a summary-widget config. */
export function resolveFbReadingSummaryAccounts(config: Record<string, unknown>): FbReadingAccountRef[] {
  if (!Array.isArray(config.accounts)) return []
  const accounts: FbReadingAccountRef[] = []
  for (const item of config.accounts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    const alias = typeof candidate.alias === 'string' ? candidate.alias.trim() : ''
    if (!alias || !isValidFbReadingAct(candidate.act)) continue
    accounts.push({
      alias,
      act: candidate.act,
      businessId: isValidFbReadingBusinessId(candidate.businessId) ? candidate.businessId : null
    })
  }
  return accounts
}

export const FB_READING_ACCOUNT_TARGETS: Record<string, { act: string; businessId: string }> = {
  三国IOS: { act: '2131017261144314', businessId: '1734414010144999' }
}

export function fbDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function boardReadingRangeDates(
  range: FbReadingRange,
  today: Date = new Date()
): { start: string; end: string } {
  if (range === 'today') {
    const s = fbDateString(today)
    return { start: s, end: s }
  }
  const n = range === 'last3' ? 3 : range === 'last7' ? 7 : 30
  const end = new Date(today)
  end.setDate(end.getDate() - 1)
  const start = new Date(today)
  start.setDate(start.getDate() - n)
  return { start: fbDateString(start), end: fbDateString(end) }
}

/** Visible Chinese date label, not the requested URL or an inferred preset. */
export function parseFbReadingDateRange(label: string | null): { start: string; end: string } | null {
  const text = label?.trim() ?? ''
  const match = text.match(/^(?:(?:今天|昨天|过去 \d+ 天|过去 \d+ 周|本月|上年)[：:]\s*)?(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*[–—-]\s*(\d{4})年(\d{1,2})月(\d{1,2})日)?$/)
  if (!match) return parseFbReadingDateRangeEn(label)
  const date = (offset: number): string | null => {
    const [y, m, d] = match.slice(offset, offset + 3).map(Number)
    const value = new Date(y, m - 1, d)
    return value.getFullYear() === y && value.getMonth() === m - 1 && value.getDate() === d
      ? fbDateString(value)
      : null
  }
  const start = date(1)
  const end = match[4] ? date(4) : start
  return start && end && start <= end ? { start, end } : null
}

const FB_EN_MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7,
  Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12
}

/** English-UI labels: "Sep 15 – Sep 17, 2026" / "Sep 15, 2026 – Sep 21, 2026"
 * (FB added the year to the start date too, observed live 2026-09-22) /
 * "Today: Sep 18, 2026". */
export function parseFbReadingDateRangeEn(label: string | null): { start: string; end: string } | null {
  const text = label?.trim() ?? ''
  const stripped = text.replace(/^(?:Today|Yesterday|Last \d+ days?|This month|This year|Last year)[：:]?\s*/, '')
  const single = stripped.match(/^([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})$/)
  const range = stripped.match(/^([A-Z][a-z]{2,8})\.? (\d{1,2})(?:, (\d{4}))? – ([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})$/)
  const month = (name: string): number | null => FB_EN_MONTHS[name] ?? null
  const build = (y: number, m: number, d: number): string | null => {
    const value = new Date(y, m - 1, d)
    return value.getFullYear() === y && value.getMonth() === m - 1 && value.getDate() === d
      ? fbDateString(value)
      : null
  }
  if (range) {
    const m1 = month(range[1])
    const m2 = month(range[4])
    if (!m1 || !m2) return null
    const startYear = range[3] ? Number(range[3]) : Number(range[6])
    const start = build(startYear, m1, Number(range[2]))
    const end = build(Number(range[6]), m2, Number(range[5]))
    return start && end && start <= end ? { start, end } : null
  }
  if (single) {
    const m = month(single[1])
    if (!m) return null
    const day = build(Number(single[3]), m, Number(single[2]))
    return day ? { start: day, end: day } : null
  }
  return null
}

export function fbReadingMatchesWindow(
  reading: { accountId: string | null; dateRangeLabel: string | null },
  accountId: string,
  window: { start: string; end: string }
): boolean {
  const actual = parseFbReadingDateRange(reading.dateRangeLabel)
  return reading.accountId === accountId && actual?.start === window.start && actual.end === window.end
}

/** One campaign row of a verified reading (history projection shape). */
export interface FbReadingHistoryRow {
  name: string
  spend: number | null
  costPerResult: number | null
  cpm: number | null
  impressions: number | null
  results: number | null
  resultType: string | null
  clicks: number | null
  ctr: number | null
  cpc: number | null
  installs: number | null
}

/** A verified reading as stored in fb-readings.json and served to widgets. */
export interface FbReadingHistoryEntry {
  id: string
  capturedAt: string
  accountId: string
  accountName: string | null
  dateRangeLabel: string | null
  campaignCount: number | null
  totalSpend: number | null
  rows: FbReadingHistoryRow[]
}

/** Result of driving navigate + browser_report from the reading module. */
export type FbReadingRefreshResult =
  | { ok: true; entry: FbReadingHistoryEntry }
  | { ok: false; error: string }

/** History list for the reading module (latest verified entries first). */
export type FbReadingHistoryListResult = FbReadingHistoryEntry[]

/** Summary accounts refresh serially; each extra account adds one full
 * pipeline pass per refresh, so the cap keeps board refreshes bounded. */
export const FB_READING_SUMMARY_ACCOUNT_LIMIT = 30
export const FB_READING_SUMMARY_METRICS = ['spend', 'cpi', 'cpm', 'ctr', 'cpa', 'balance'] as const
export type FbReadingSummaryMetric = (typeof FB_READING_SUMMARY_METRICS)[number]

export type FbAccountBalanceRefreshResult =
  | { ok: true; balance: FbAccountBalance & { id?: string } }
  | { ok: false; error: string }

export interface FbReadingSummaryAccount {
  alias: string
  act: string
  capturedAt: string
  campaignCount: number | null
  spend: number | null
  installs: number | null
  impressions: number | null
  clicks: number | null
  results: number | null
  resultType: string | null
  cpi: number | null
  cpm: number | null
  ctr: number | null
  cpa: number | null
  balance: number | null
  balanceKind: FbAccountBalance['kind'] | null
  balanceCurrency: string | null
  balanceText: string | null
}

export interface FbReadingSummary {
  complete: boolean
  verifiedCount: number
  accountCount: number
  capturedAt: string | null
  campaignCount: number | null
  spend: number | null
  installs: number | null
  impressions: number | null
  clicks: number | null
  results: number | null
  resultType: string | null
  cpi: number | null
  cpm: number | null
  ctr: number | null
  cpa: number | null
  balance: number | null
  balanceKind: FbAccountBalance['kind'] | null
  balanceCurrency: string | null
  balanceText: string | null
  accounts: FbReadingSummaryAccount[]
}

const APP_INSTALL_RESULT_TYPES = new Set(['应用安装量', '移动应用安装量', 'App installs', 'Mobile app installs'])

function sumAll(values: Array<number | null | undefined>): number | null {
  if (values.some((value) => value === null || value === undefined)) return null
  return values.reduce<number>((total, value) => (value === null || value === undefined ? total : total + value), 0)
}

function installCountOf(row: FbReadingHistoryRow): number | null {
  if (row.installs !== null && row.installs !== undefined) return row.installs
  if (row.resultType && APP_INSTALL_RESULT_TYPES.has(row.resultType)) return row.results ?? null
  return null
}

function metricRatio(numerator: number | null, denominator: number | null, factor = 1): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null
  return (numerator / denominator) * factor
}

function projectSummaryAccount(
  ref: FbReadingAccountRef,
  entry: FbReadingHistoryEntry,
  balance: FbAccountBalance | null | undefined
): FbReadingSummaryAccount {
  const rows = entry.rows ?? []
  const spend = sumAll(rows.map((row) => row.spend))
  const installs = sumAll(rows.map(installCountOf))
  const impressions = sumAll(rows.map((row) => row.impressions ?? null))
  const clicks = sumAll(rows.map((row) => row.clicks))
  const results = sumAll(rows.map((row) => row.results))
  const resultTypes = Array.from(new Set(rows.map((row) => row.resultType).filter((type): type is string => Boolean(type))))
  const resultType = resultTypes.length === 1 ? resultTypes[0] : null
  return {
    alias: ref.alias,
    act: ref.act,
    capturedAt: entry.capturedAt,
    campaignCount: entry.campaignCount ?? rows.length,
    spend,
    installs,
    impressions,
    clicks,
    results,
    resultType,
    cpi: metricRatio(spend, installs),
    cpm: metricRatio(spend, impressions, 1000),
    ctr: metricRatio(clicks, impressions, 100),
    cpa: resultType ? metricRatio(spend, results) : null,
    balance: balance?.amount ?? null,
    balanceKind: balance?.kind ?? null,
    balanceCurrency: balance?.currency ?? null,
    balanceText: balance?.amountText ?? null
  }
}

function emptySummaryAccount(ref: FbReadingAccountRef, balance: FbAccountBalance | null | undefined): FbReadingSummaryAccount {
  return {
    alias: ref.alias,
    act: ref.act,
    capturedAt: '',
    campaignCount: null,
    spend: null,
    installs: null,
    impressions: null,
    clicks: null,
    results: null,
    resultType: null,
    cpi: null,
    cpm: null,
    ctr: null,
    cpa: null,
    balance: balance?.amount ?? null,
    balanceKind: balance?.kind ?? null,
    balanceCurrency: balance?.currency ?? null,
    balanceText: balance?.amountText ?? null
  }
}

/**
 * Aggregate verified account readings into one product-level projection.
 * Additive fields sum first; CPI/CPM/CTR/CPA are recomputed from summed
 * denominators. Missing rows leave the dependent metric null rather than
 * averaging account-level ratios.
 */
export function summarizeFbReadings(
  accounts: FbReadingAccountRef[],
  entriesByAct: Record<string, FbReadingHistoryEntry | null | undefined>,
  balancesByAct: Record<string, FbAccountBalance | null | undefined> = {}
): FbReadingSummary {
  const projected = accounts.map((ref) => {
    const entry = entriesByAct[ref.act]
    return entry ? projectSummaryAccount(ref, entry, balancesByAct[ref.act]) : emptySummaryAccount(ref, balancesByAct[ref.act])
  })
  const available = projected.filter((account): account is FbReadingSummaryAccount => account.capturedAt !== '')
  const spend = sumAll(available.map((account) => account.spend))
  const installs = sumAll(available.map((account) => account.installs))
  const impressions = sumAll(available.map((account) => account.impressions))
  const clicks = sumAll(available.map((account) => account.clicks))
  const results = sumAll(available.map((account) => account.results))
  const resultTypes = Array.from(
    new Set(available.map((account) => account.resultType).filter((type): type is string => Boolean(type)))
  )
  const resultType = resultTypes.length === 1 ? resultTypes[0] : null
  const balanceKinds = Array.from(new Set(projected.map((account) => account.balanceKind).filter(Boolean))) as Array<FbAccountBalance['kind']>
  const balanceCurrencies = Array.from(new Set(projected.map((account) => account.balanceCurrency).filter(Boolean))) as string[]
  const balanceKind = balanceKinds.length === 1 ? balanceKinds[0] : null
  const balanceCurrency = balanceCurrencies.length === 1 ? balanceCurrencies[0] : null
  const canSumBalances =
    accounts.length > 0 &&
    projected.every((account) => account.balance !== null && account.balanceKind === balanceKind && account.balanceCurrency === balanceCurrency) &&
    balanceKind !== null &&
    balanceCurrency !== null
  return {
    complete: accounts.length > 0 && available.length === accounts.length,
    verifiedCount: available.length,
    accountCount: accounts.length,
    capturedAt: available.map((account) => account.capturedAt).filter(Boolean).sort()[0] ?? null,
    campaignCount: sumAll(available.map((account) => account.campaignCount)),
    spend,
    installs,
    impressions,
    clicks,
    results,
    resultType,
    cpi: metricRatio(spend, installs),
    cpm: metricRatio(spend, impressions, 1000),
    ctr: metricRatio(clicks, impressions, 100),
    cpa: resultType ? metricRatio(spend, results) : null,
    balance: canSumBalances ? sumAll(projected.map((account) => account.balance)) : null,
    balanceKind: canSumBalances ? balanceKind : null,
    balanceCurrency: canSumBalances ? balanceCurrency : null,
    balanceText: null,
    accounts: projected
  }
}

export function buildBoardReadingUrl(account: string, range: FbReadingRange, today: Date = new Date()): string {
  const target = FB_READING_ACCOUNT_TARGETS[account]
  return buildFbReadingUrlForRef(
    target ? { alias: account, act: target.act, businessId: target.businessId } : null,
    range,
    today
  )
}

/** Canonical Ads Manager URL for one registry account reference. */
export function buildFbReadingUrlForRef(
  ref: FbReadingAccountRef | null,
  range: FbReadingRange,
  today: Date = new Date()
): string {
  if (!ref || !isValidFbReadingAct(ref.act)) return ''
  const { start, end } = boardReadingRangeDates(range, today)
  // UI/report dates are inclusive; Ads Manager's URL end is exclusive.
  const [year, month, day] = end.split('-').map(Number)
  const exclusiveEnd = fbDateString(new Date(year, month - 1, day + 1))
  const dates = `${start}_${exclusiveEnd}`
  // Canonical columns prevent each account's saved Ads Manager view from
  // omitting a denominator needed by product-level aggregation.
  const columns = [
    'name',
    'results',
    'spend',
    'impressions',
    'actions:mobile_app_install',
    'clicks'
  ].join(',')
  return (
    'https://adsmanager.facebook.com/adsmanager/manage/campaigns' +
    `?act=${ref.act}${ref.businessId ? `&business_id=${ref.businessId}` : ''}` +
    `&columns=${encodeURIComponent(columns)}` +
    `&date=${dates}&insights_date=${dates}`
  )
}

/** Read-only Ads Manager Account Overview URL pinned to one ad account. */
export function buildFbAccountOverviewUrlForRef(ref: FbReadingAccountRef | null): string {
  if (!ref || !isValidFbReadingAct(ref.act)) return ''
  const params = new URLSearchParams({
    act: ref.act,
    nav_entry_point: 'ads_ecosystem_navigation_menu',
    nav_source: 'ads_manager'
  })
  if (ref.businessId) params.set('business_id', ref.businessId)
  return `https://adsmanager.facebook.com/adsmanager/manage/accounts?${params.toString()}`
}
