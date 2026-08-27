import { CliRunner } from './OmpConfigCli'

/**
 * The login-provider registry: `omp auth-broker list --json`.
 *
 * Unlike the RPC `get_login_providers` probe this is a pure CLI read — no
 * runtime spawn, no credentials needed, sub-second. That makes it the stable
 * data source for the Settings provider dropdown: the list must survive a
 * dead/slow probe, because without it the user cannot pick a provider at all.
 *
 * The registry carries identity only ({id, name}); authentication state is
 * layered on by RuntimeSettings (probe truth, `omp models --json` fallback).
 */

export interface LoginProviderEntry {
  id: string
  name: string
}

/** Aligns with RuntimeSettings' OVERVIEW_TTL_MS — one coherent refresh cadence. */
const REGISTRY_TTL_MS = 15_000

/**
 * Defensive parse of the `--json` payload. Returns null when the contract is
 * broken (non-array top level) so the caller can report 'unknown' instead of
 * pretending "zero providers"; entries without a string id are dropped.
 */
export function parseLoginProviders(stdout: string): LoginProviderEntry[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: LoginProviderEntry[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { id?: unknown; name?: unknown }
    if (typeof e.id !== 'string' || !e.id) continue
    out.push({ id: e.id, name: typeof e.name === 'string' && e.name ? e.name : e.id })
  }
  return out
}

/**
 * Cached registry reader. The cache is instance-scoped (never module-level),
 * so tests injecting fresh runners can never observe each other's results.
 * Failures are cached too — the overview itself refreshes on the same TTL.
 */
export class ProviderRegistry {
  private cache: { at: number; providers: LoginProviderEntry[] | null } | null = null

  constructor(private readonly ttlMs: number = REGISTRY_TTL_MS) {}

  invalidate(): void {
    this.cache = null
  }

  /**
   * Registered login providers, or null when the CLI call failed / returned
   * an unparseable payload (→ capability 'unknown', never 'unsupported').
   */
  async list(run: CliRunner): Promise<LoginProviderEntry[] | null> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.providers
    }
    const res = await run(['auth-broker', 'list', '--json'])
    const providers = res.ok ? parseLoginProviders(res.stdout) : null
    this.cache = { at: Date.now(), providers }
    return providers
  }
}
