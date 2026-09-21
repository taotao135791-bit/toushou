import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Optional best-effort ranking of discovered FB ad accounts via TypeSafe's
 * System One (Jev): one Score question per account, batched in a single
 * request, judging from the account name whether it looks like a primary,
 * secondary, or test/backup account. Every failure mode (no key, timeout,
 * bad response) silently falls back to the original discovery order —
 * ranking must never block or break discovery.
 */
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const SCORE_LEVELS = [
  'test, backup, or placeholder ad account (throwaway or template naming)',
  'secondary ad account (real campaigns, side or niche usage)',
  'primary actively-used ad account (main campaigns, meaningful naming)'
]

/** Dev-only convenience: repo-root .env.local is gitignored. */
function readLocalApiKey(): string | null {
  if (app.isPackaged) return null
  try {
    const text = readFileSync(join(app.getAppPath(), '.env.local'), 'utf8')
    const match = text.match(/^TYPESAFE_API_KEY=(\S+)\s*$/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export interface FbReadingDiscoveredAccount {
  name: string
  act: string
}

export async function rankFbReadingAccountsByUsage(
  accounts: FbReadingDiscoveredAccount[]
): Promise<{ accounts: FbReadingDiscoveredAccount[]; ranked: boolean }> {
  if (accounts.length < 2) return { accounts, ranked: false }
  const apiKey = process.env.TYPESAFE_API_KEY || readLocalApiKey()
  if (!apiKey) return { accounts, ranked: false }
  const questions: Record<string, unknown> = {}
  for (const account of accounts) {
    questions[`act_${account.act}`] = {
      type: 'score',
      instructions: 'Judging only by this ad account\'s name, how actively is it used for real advertising?',
      criteria: SCORE_LEVELS
    }
  }
  try {
    const response = await fetch(TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        state: { accounts: accounts.map((a) => ({ id: a.act, name: a.name })) },
        model: 'jev-latest',
        questions
      }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) return { accounts, ranked: false }
    const data = (await response.json()) as {
      answers?: Record<string, { score?: unknown }>
    }
    const scoreOf = (act: string): number => {
      const answer = data.answers?.[`act_${act}`]
      return typeof answer?.score === 'number' ? answer.score : Number.NaN
    }
    if (!accounts.some((a) => Number.isFinite(scoreOf(a.act)))) {
      return { accounts, ranked: false }
    }
    const ranked = [...accounts].sort((x, y) => {
      const sx = scoreOf(x.act)
      const sy = scoreOf(y.act)
      if (Number.isFinite(sx) && Number.isFinite(sy)) return sy - sx
      if (Number.isFinite(sx)) return -1
      if (Number.isFinite(sy)) return 1
      return 0
    })
    return { accounts: ranked, ranked: true }
  } catch {
    return { accounts, ranked: false }
  }
}
