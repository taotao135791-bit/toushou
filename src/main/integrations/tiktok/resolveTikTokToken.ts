import type { TikTokStoredCredentials } from './TikTokCredentialStore'
import { loadTikTokCredentials, type TikTokReportCredentials } from './TikTokConnectionStore'

/**
 * Single token source for every TikTok 报表 reader (TT 读数 board module,
 * the auto-refresh service, the toolkit bridge): prefer the official OAuth
 * connector's stored token — Main refreshes it automatically before expiry —
 * and fall back to the paste-token quick path only when no OAuth grant
 * exists or the connector fails to load.
 *
 * The OAuth credential loader is injected by ipc.ts (the app-wide
 * TikTokAdsConnectionManager lives there); until it is registered — and in
 * every test — the OAuth path reports "absent" instead of touching electron.
 */

export type ResolvedTikTokToken =
  | { token: string; source: 'oauth' | 'pasted'; advertiserIds: number[] }
  | { token: null; source: 'none' }

export interface ResolveTikTokTokenDeps {
  /** OAuth connector accessor (auto-refreshing). Defaults to the registered app loader. */
  loadOAuthCredentials?: () => Promise<TikTokStoredCredentials | null>
  /** Paste-token store fallback. Defaults to loadTikTokCredentials() on the default file. */
  loadPastedCredentials?: () => TikTokReportCredentials | null
}

// Registered from ipc.ts; a lazy indirection so importing this module never
// constructs electron-backed stores (keeps the service singleton test-safe).
let oauthLoader: (() => Promise<TikTokStoredCredentials | null>) | null = null

/**
 * Wire the app-wide OAuth connector accessor. Called once from ipc.ts when
 * the manager instance is created; later calls simply replace it.
 */
export function setTikTokOAuthCredentialLoader(
  loader: () => Promise<TikTokStoredCredentials | null>
): void {
  oauthLoader = loader
}

async function defaultOAuthLoader(): Promise<TikTokStoredCredentials | null> {
  if (!oauthLoader) return null
  try {
    return await oauthLoader()
  } catch {
    // A broken connector (e.g. unreadable safeStorage envelope) must not take
    // the reading modules down — the paste fallback stays usable.
    return null
  }
}

function fromOAuth(credentials: TikTokStoredCredentials | null): ResolvedTikTokToken | null {
  if (!credentials?.accessToken) return null
  return { token: credentials.accessToken, source: 'oauth', advertiserIds: credentials.advertiserIds ?? [] }
}

function fromPasted(credentials: TikTokReportCredentials | null): ResolvedTikTokToken | null {
  if (!credentials?.accessToken) return null
  return { token: credentials.accessToken, source: 'pasted', advertiserIds: credentials.advertisers ?? [] }
}

/**
 * Resolve the access token the report pipeline should use right now.
 * OAuth wins when both sources hold a token (it auto-refreshes); the paste
 * store is the fallback; `source: 'none'` means the caller must surface a
 * not-connected state.
 */
export async function resolveTikTokToken(
  deps: ResolveTikTokTokenDeps = {}
): Promise<ResolvedTikTokToken> {
  const loadOAuth = deps.loadOAuthCredentials ?? defaultOAuthLoader
  // Any OAuth-side failure (loader throw, unreadable envelope) degrades to
  // "no OAuth token" so the paste fallback stays reachable.
  const credentials = await loadOAuth().catch(() => null)
  const oauth = fromOAuth(credentials)
  if (oauth) return oauth
  const loadPasted = deps.loadPastedCredentials ?? (() => loadTikTokCredentials())
  const pasted = fromPasted(loadPasted())
  if (pasted) return pasted
  return { token: null, source: 'none' }
}
