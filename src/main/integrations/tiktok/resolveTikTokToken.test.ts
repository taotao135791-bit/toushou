import { describe, expect, it, vi } from 'vitest'

// The resolver's default paste loader resolves its file via electron's app —
// stub it; every case injects its loaders anyway.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-unused' } }))

import { resolveTikTokToken } from './resolveTikTokToken'
import type { TikTokStoredCredentials } from './TikTokCredentialStore'
import type { TikTokReportCredentials } from './TikTokConnectionStore'

const oauthCredentials = (overrides: Partial<TikTokStoredCredentials> = {}): TikTokStoredCredentials => ({
  clientId: 'client-1',
  accessToken: 'oauth-token',
  refreshToken: 'oauth-refresh',
  savedAt: 0,
  ...overrides
})

const pastedCredentials = (overrides: Partial<TikTokReportCredentials> = {}): TikTokReportCredentials => ({
  accessToken: 'pasted-token',
  savedAt: 0,
  ...overrides
})

describe('resolveTikTokToken', () => {
  it('prefers the OAuth connector token when both sources hold one', async () => {
    const loadPastedCredentials = vi.fn(() => pastedCredentials())
    const resolved = await resolveTikTokToken({
      loadOAuthCredentials: async () => oauthCredentials(),
      loadPastedCredentials
    })
    expect(resolved).toEqual({
      token: 'oauth-token',
      source: 'oauth',
      advertiserIds: []
    })
    // The paste store is never even consulted when OAuth answers.
    expect(loadPastedCredentials).not.toHaveBeenCalled()
  })

  it('carries the persisted OAuth advertiser ids', async () => {
    const resolved = await resolveTikTokToken({
      loadOAuthCredentials: async () => oauthCredentials({ advertiserIds: [7300001, 7300002] })
    })
    expect(resolved.source).toBe('oauth')
    if (resolved.source !== 'oauth') return
    expect(resolved.advertiserIds).toEqual([7300001, 7300002])
  })

  it('falls back to the paste store when OAuth has no token', async () => {
    const resolved = await resolveTikTokToken({
      loadOAuthCredentials: async () => oauthCredentials({ accessToken: undefined }),
      loadPastedCredentials: () => pastedCredentials({ advertisers: [7300009] })
    })
    expect(resolved).toEqual({
      token: 'pasted-token',
      source: 'pasted',
      advertiserIds: [7300009]
    })
  })

  it('falls back to the paste store when the OAuth loader throws', async () => {
    const resolved = await resolveTikTokToken({
      loadOAuthCredentials: async () => {
        throw new Error('safeStorage unavailable')
      },
      loadPastedCredentials: () => pastedCredentials()
    })
    expect(resolved.source).toBe('pasted')
    expect(resolved.token).toBe('pasted-token')
  })

  it('reports none when neither source holds a token', async () => {
    const resolved = await resolveTikTokToken({
      loadOAuthCredentials: async () => null,
      loadPastedCredentials: () => null
    })
    expect(resolved).toEqual({ token: null, source: 'none' })
  })
})
