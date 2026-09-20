export interface FbAccountBalanceSnapshotInput {
  url?: string
  title?: string
  text: string
  observedAt?: number
}

export type FbAccountBalanceKind = 'available' | 'due'

export interface FbAccountBalance {
  accountId: string
  kind: FbAccountBalanceKind
  /** Numeric value in account currency; negative means amount owed. */
  amount: number
  currency: string | null
  /** Exact page-rendered amount, retained so non-USD accounts never get re-formatted. */
  amountText: string
  label: string
  capturedAt: string
  sourceUrl: string | null
}

export type FbAccountBalanceParseResult =
  | { kind: 'ok'; balance: FbAccountBalance }
  | { kind: 'account-mismatch' }
  | { kind: 'balance-not-found' }

const AVAILABLE_LABELS = [
  '账户余额',
  '当前余额',
  '可用余额',
  '预付余额',
  '预付金额',
  '剩余金额',
  'Account balance',
  'Current balance',
  'Available balance',
  'Prepaid balance'
]

const DUE_LABELS = [
  '待支付金额',
  '待付款金额',
  '当前待付款',
  '欠款金额',
  'Amount due',
  'Amount pending',
  'Outstanding balance'
]

const ACCOUNT_SPEND_LIMIT_LABEL = /^账户花费限额\s*[：:]?$/
const SPENT_LABEL = /已花费\s*(US\$|\$|HK\$|NT\$|S\$)?\s*([\d,]+(?:\.\d+)?)/

const ACCOUNT_TEXT_PATTERNS = [
  new RegExp(`[（(]${'\\d{6,20}'}[)）]`),
  /广告账户编号[：:]\s*\d{6,20}/,
  /Ad account ID[：:]\s*\d{6,20}/i
]

function normalize(line: string): string {
  return line.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()
}

function cleanLabel(line: string): string {
  return normalize(line)
    .replace(/[：:]$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
}

function parseAmount(line: string): { amount: number; currency: string | null; text: string } | null {
  const value = normalize(line)
  if (value === '') return null
  const match = value.match(/^(?:([A-Z]{3})\s*)?(US\$|\$|HK\$|NT\$|S\$|¥|￥)?\s*(-?)\$?([\d,]+(?:\.\d+)?)\s*([A-Z]{3})?$/)
  if (!match) return null
  const [, beforeCurrency, symbol, sign, digits, afterCurrency] = match
  const amount = Number(digits.replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  const currency = (beforeCurrency ?? afterCurrency ?? (symbol === 'US$' || symbol === '$' ? 'USD' : null)) ?? null
  return {
    amount: sign === '-' ? -amount : amount,
    currency,
    text: value
  }
}

function accountMatches(url: string | undefined, text: string, expectedAct: string): boolean {
  const textAccountIds: string[] = []
  for (const match of text.matchAll(/[（(](\d{6,20})[）)]|广告账户编号[：:]\s*(\d{6,20})/g)) {
    textAccountIds.push(match[1] ?? match[2] ?? '')
  }
  try {
    const parsed = typeof url === 'string' ? new URL(url) : null
    const urlAct =
      parsed?.searchParams.get('asset_id') ??
      parsed?.searchParams.get('act') ??
      parsed?.searchParams.get('payment_account_id') ??
      parsed?.searchParams.get('payment_account_id_from_jsmodule') ??
      null
    if (urlAct !== null && textAccountIds.length > 0) {
      return urlAct === expectedAct && textAccountIds.every((act) => act === expectedAct)
    }
    if (urlAct !== null) return urlAct === expectedAct
  } catch {
    // A malformed redirect URL falls through to the text identity checks.
  }
  const expected = new RegExp(`(?:[（(]|：|:|编号[：:])${expectedAct}[）)]?`)
  return ACCOUNT_TEXT_PATTERNS.some((pattern) => pattern.test(text)) && expected.test(text)
}

function findBalance(lines: string[], labels: readonly string[]): { label: string; parsed: ReturnType<typeof parseAmount> } | null {
  const normalizedLabels = new Set(labels.map((label) => label.toLowerCase()))
  for (let index = 0; index < lines.length; index += 1) {
    const label = cleanLabel(lines[index])
    if (!normalizedLabels.has(label.toLowerCase())) continue
    for (let offset = -2; offset <= 2; offset += 1) {
      if (offset === 0) continue
      const parsed = parseAmount(lines[index + offset] ?? '')
      if (parsed) return { label, parsed }
    }
  }
  return null
}

function formatAmount(amount: number, currency: string | null): string {
  const sign = amount < 0 ? '-' : ''
  const digits = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
  if (currency === 'USD') return `${sign}$${digits}`
  return currency ? `${sign}${digits} ${currency}` : `${sign}${digits}`
}

function findAccountOverviewAvailable(lines: string[]): Omit<FbAccountBalance, 'accountId' | 'capturedAt' | 'sourceUrl'> | null {
  let limit: ReturnType<typeof parseAmount> | null = null
  for (let index = 0; index < lines.length; index += 1) {
    if (!ACCOUNT_SPEND_LIMIT_LABEL.test(lines[index])) continue
    limit = parseAmount(lines[index + 1] ?? '')
    if (limit) break
  }
  if (!limit) return null

  let spent: ReturnType<typeof parseAmount> | null = null
  for (const line of lines) {
    const match = line.match(SPENT_LABEL)
    if (!match) continue
    const parsed = parseAmount(`${match[1] ?? ''}${match[2]}`)
    if (parsed) {
      spent = parsed
      break
    }
  }
  if (!spent) return null

  const availableAmount = Math.round((limit.amount - spent.amount) * 100) / 100
  return {
    kind: 'available',
    amount: availableAmount,
    currency: limit.currency,
    amountText: formatAmount(availableAmount, limit.currency),
    label: '账户花费限额剩余'
  }
}

/**
 * Strict parser for an ad-account balance surface. The normal route is the
 * read-only Account Overview, where available spend is derived only from its
 * explicitly labeled spend limit and spend. Billing-page labeled balances are
 * also supported. The page URL or text must identify the expected ad account;
 * any other shape refuses the number rather than guessing.
 */
export function parseFbAccountBalanceSnapshot(
  input: FbAccountBalanceSnapshotInput,
  expectedAct: string
): FbAccountBalanceParseResult {
  if (!input || typeof input.text !== 'string' || !/^\d{6,20}$/.test(expectedAct)) return { kind: 'balance-not-found' }
  const text = input.text.replace(/\u200b/g, '').trim()
  const lines = text.split('\n').map(normalize).filter((line) => line !== '')
  if (lines.length === 0) return { kind: 'balance-not-found' }
  if (!accountMatches(input.url, text, expectedAct)) return { kind: 'account-mismatch' }

  const overview = /adsmanager\.facebook\.com\/adsmanager\/manage\/accounts/i.test(input.url ?? '')
    ? findAccountOverviewAvailable(lines)
    : null
  const available = overview ? { label: overview.label, parsed: { amount: overview.amount, currency: overview.currency, text: overview.amountText } } : findBalance(lines, AVAILABLE_LABELS)
  const due = findBalance(lines, DUE_LABELS)
  const hit = available ?? due
  if (!hit || !hit.parsed) return { kind: 'balance-not-found' }

  return {
    kind: 'ok',
    balance: {
      accountId: expectedAct,
      kind: available ? 'available' : 'due',
      amount: hit.parsed.amount,
      currency: hit.parsed.currency,
      amountText: hit.parsed.text,
      label: hit.label,
      capturedAt:
        typeof input.observedAt === 'number' && Number.isFinite(input.observedAt)
          ? new Date(input.observedAt).toISOString()
          : new Date().toISOString(),
      sourceUrl: typeof input.url === 'string' ? input.url : null
    }
  }
}
