import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  TikTokCredentialErrorCode,
  TikTokCredentialInfo,
  TikTokCredentialInput,
  TikTokCredentialMode
} from '../../../shared/tiktokReport'

/**
 * TikTok Ads 后台报表接入的凭据存储 — userData 下的一个 0600 JSON 文档
 * （atomic tmp+rename 写入，与 board-datasets.ts 同款）。MCP 连接器用的是
 * safeStorage 加密信封（TikTokCredentialStore），这里是报表 Open API 自己
 * 的快速通路：用户可直接粘贴开发者控制台的 access token，也可保存 OAuth
 * 换取的长期凭据。渲染层只见 listTikTokCredentials 的脱敏投影。
 */

export const TIKTOK_REPORT_CREDENTIALS_FILE = 'tiktok-report-credentials.json'

/** 长度上限 — 越界即拒绝（IPC 输入校验的 Main 侧兜底）。 */
export const TIKTOK_CREDENTIAL_LIMITS = {
  maxIdLength: 64,
  maxSecretLength: 256,
  maxTokenLength: 4096,
  maxAdvertisers: 50
} as const

export interface TikTokReportCredentials {
  appId?: string
  appSecret?: string
  accessToken: string
  refreshToken?: string
  /** 授权返回（或用户手填）的广告主 ID 列表。 */
  advertisers?: number[]
  /** access token 到期时间（epoch ms）。 */
  expiresAt?: number
  /** 粘贴路径的 token 签发时间（epoch ms）。 */
  issuedAt?: number
  savedAt: number
}

export function defaultCredentialsFile(): string {
  return path.join(app.getPath('userData'), TIKTOK_REPORT_CREDENTIALS_FILE)
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_RE.test(value)
}

export type TikTokCredentialParseResult =
  | { ok: true; credentials: Omit<TikTokReportCredentials, 'savedAt'> }
  | { ok: false; error: TikTokCredentialErrorCode }

/**
 * Validate one credentials payload crossing IPC. Only bounded strings and
 * plain numbers are accepted — in particular never a filesystem path. An
 * empty/absent accessToken is legal input meaning "keep the stored token"
 * (e.g. editing only the advertiser list); setTikTokCredentials enforces
 * that a record ends up with a token.
 */
export function parseTikTokCredentialInput(raw: unknown): TikTokCredentialParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid-input' }
  const input = raw as TikTokCredentialInput
  if (input.accessToken !== undefined && input.accessToken !== '') {
    if (!isBoundedString(input.accessToken, TIKTOK_CREDENTIAL_LIMITS.maxTokenLength)) {
      return { ok: false, error: 'invalid-token' }
    }
  }
  const credentials: Omit<TikTokReportCredentials, 'savedAt'> = {
    accessToken: typeof input.accessToken === 'string' ? input.accessToken.trim() : ''
  }
  if (input.appId !== undefined && input.appId !== '') {
    if (!isBoundedString(input.appId, TIKTOK_CREDENTIAL_LIMITS.maxIdLength)) {
      return { ok: false, error: 'invalid-app-id' }
    }
    credentials.appId = input.appId.trim()
  }
  if (input.appSecret !== undefined && input.appSecret !== '') {
    if (!isBoundedString(input.appSecret, TIKTOK_CREDENTIAL_LIMITS.maxSecretLength)) {
      return { ok: false, error: 'invalid-secret' }
    }
    credentials.appSecret = input.appSecret.trim()
  }
  if (input.refreshToken !== undefined && input.refreshToken !== '') {
    if (!isBoundedString(input.refreshToken, TIKTOK_CREDENTIAL_LIMITS.maxTokenLength)) {
      return { ok: false, error: 'invalid-refresh-token' }
    }
    credentials.refreshToken = input.refreshToken.trim()
  }
  if (input.advertiserIds !== undefined) {
    if (!Array.isArray(input.advertiserIds) || input.advertiserIds.length > TIKTOK_CREDENTIAL_LIMITS.maxAdvertisers) {
      return { ok: false, error: 'invalid-advertisers' }
    }
    const ids: number[] = []
    for (const entry of input.advertiserIds) {
      const id = typeof entry === 'number' ? entry : typeof entry === 'string' ? Number.parseInt(entry.trim(), 10) : Number.NaN
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid-advertisers' }
      if (!ids.includes(id)) ids.push(id)
    }
    if (ids.length > 0) credentials.advertisers = ids
  }
  // Expiry metadata: optional, bounded to sane epoch-millis values. The
  // paste-token path may carry an issue time; the OAuth completion path
  // passes the exchanged expiry.
  const epoch = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 4_102_444_800_000 ? value : undefined
  const expiresAt = epoch((raw as Record<string, unknown>).expiresAt)
  if (expiresAt !== undefined) credentials.expiresAt = expiresAt
  const issuedAt = epoch((raw as Record<string, unknown>).issuedAt)
  if (issuedAt !== undefined) credentials.issuedAt = issuedAt
  return { ok: true, credentials }
}

function readCredentialsFile(file: string): TikTokReportCredentials | null {
  if (!existsSync(file)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  if (!isBoundedString(entry.accessToken, TIKTOK_CREDENTIAL_LIMITS.maxTokenLength)) return null
  const credentials: TikTokReportCredentials = { accessToken: entry.accessToken, savedAt: typeof entry.savedAt === 'number' ? entry.savedAt : 0 }
  if (isBoundedString(entry.appId, TIKTOK_CREDENTIAL_LIMITS.maxIdLength)) credentials.appId = entry.appId
  if (isBoundedString(entry.appSecret, TIKTOK_CREDENTIAL_LIMITS.maxSecretLength)) credentials.appSecret = entry.appSecret
  if (isBoundedString(entry.refreshToken, TIKTOK_CREDENTIAL_LIMITS.maxTokenLength)) credentials.refreshToken = entry.refreshToken
  if (Array.isArray(entry.advertisers)) {
    const ids = entry.advertisers.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0)
    if (ids.length > 0) credentials.advertisers = ids
  }
  if (typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) && entry.expiresAt >= 0) {
    credentials.expiresAt = entry.expiresAt
  }
  if (typeof entry.issuedAt === 'number' && Number.isFinite(entry.issuedAt) && entry.issuedAt >= 0) {
    credentials.issuedAt = entry.issuedAt
  }
  return credentials
}

function writeCredentialsFile(file: string, credentials: TikTokReportCredentials): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(credentials, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Best effort — the write above already requested 0600.
  }
}

/** Persist (create-or-replace) the single TikTok report credentials record. */
export function saveTikTokCredentials(
  credentials: Omit<TikTokReportCredentials, 'savedAt'>,
  file: string = defaultCredentialsFile()
): TikTokReportCredentials {
  const stored: TikTokReportCredentials = { ...credentials, savedAt: Date.now() }
  writeCredentialsFile(file, stored)
  return stored
}

export type TikTokCredentialsSetOutcome =
  | { ok: true; info: TikTokCredentialInfo }
  | { ok: false; error: TikTokCredentialErrorCode }

/**
 * One-call IPC entry: validate → merge with any stored record → persist →
 * masked projection. An empty accessToken keeps the stored token (so the
 * user can edit app secret / advertiser list without re-pasting); a fresh
 * token resets its expiry metadata and records its issue time.
 */
export function setTikTokCredentials(
  raw: unknown,
  file: string = defaultCredentialsFile()
): TikTokCredentialsSetOutcome {
  const parsed = parseTikTokCredentialInput(raw)
  if (!parsed.ok) return parsed
  const current = readCredentialsFile(file)
  const freshToken = parsed.credentials.accessToken
  const accessToken = freshToken || current?.accessToken
  if (!accessToken) return { ok: false, error: 'missing-token' }
  saveTikTokCredentials(
    {
      accessToken,
      appId: parsed.credentials.appId ?? current?.appId,
      appSecret: parsed.credentials.appSecret ?? current?.appSecret,
      refreshToken: parsed.credentials.refreshToken ?? current?.refreshToken,
      advertisers: parsed.credentials.advertisers ?? current?.advertisers,
      // A freshly pasted token has unknown expiry unless the caller says so;
      // the previous token's expiry must not bleed into it.
      expiresAt:
        parsed.credentials.expiresAt ?? (freshToken ? undefined : current?.expiresAt),
      issuedAt: parsed.credentials.issuedAt ?? (freshToken ? Date.now() : current?.issuedAt)
    },
    file
  )
  return { ok: true, info: listTikTokCredentials(file) }
}

/** Merge token-exchange / refresh output into the stored record (keeps ids). */
export function mergeTikTokTokens(
  tokens: { accessToken: string; expiresAt?: number; refreshToken?: string; advertisers?: number[] },
  file: string = defaultCredentialsFile()
): TikTokReportCredentials {
  const current = readCredentialsFile(file) ?? { accessToken: tokens.accessToken, savedAt: 0 }
  const stored: TikTokReportCredentials = {
    ...current,
    accessToken: tokens.accessToken,
    savedAt: Date.now(),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.advertisers && tokens.advertisers.length > 0 ? { advertisers: tokens.advertisers } : {})
  }
  writeCredentialsFile(file, stored)
  return stored
}

export function loadTikTokCredentials(file: string = defaultCredentialsFile()): TikTokReportCredentials | null {
  return readCredentialsFile(file)
}

export function clearTikTokCredentials(file: string = defaultCredentialsFile()): void {
  try {
    unlinkSync(file)
  } catch {
    // Already absent is the desired outcome.
  }
}

/** First/last-3 masking so the renderer can show WHICH token without the token. */
export function maskTikTokSecret(value: string): string {
  if (value.length <= 8) return '••••••••'
  return `${value.slice(0, 3)}…${value.slice(-3)}`
}

function credentialMode(credentials: TikTokReportCredentials): TikTokCredentialMode {
  if (credentials.refreshToken && credentials.appId) return 'oauth'
  return 'pasted-token'
}

/** The only renderer-facing projection — masked, secret-free. */
export function listTikTokCredentials(file: string = defaultCredentialsFile()): TikTokCredentialInfo {
  const credentials = readCredentialsFile(file)
  if (!credentials) {
    return { configured: false, mode: 'none', tokenMasked: '', hasRefreshToken: false, advertiserIds: [] }
  }
  return {
    configured: true,
    mode: credentialMode(credentials),
    ...(credentials.appId ? { appIdMasked: maskTikTokSecret(credentials.appId) } : {}),
    tokenMasked: maskTikTokSecret(credentials.accessToken),
    hasRefreshToken: Boolean(credentials.refreshToken),
    advertiserIds: credentials.advertisers ?? [],
    ...(credentials.expiresAt !== undefined ? { expiresAt: credentials.expiresAt } : {}),
    ...(credentials.issuedAt !== undefined ? { issuedAt: credentials.issuedAt } : {}),
    ...(credentials.savedAt ? { savedAt: credentials.savedAt } : {})
  }
}
