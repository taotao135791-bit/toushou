import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// No real network, no real keychain, no windows — fetch/openExternal are
// injected fakes and electron is stubbed with temp dirs.
const paths = vi.hoisted(() => ({ documents: '', userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (key: string) => paths[key as keyof typeof paths] ?? '/tmp/toushou-tiktok-fallback' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() }
}))

import { TikTokAdsConnectionManager, TikTokFetch } from './TikTokAdsConnectionManager'
import { TikTokCredentialStore } from './TikTokCredentialStore'
import { TIKTOK_ADS_SKILL_FILE_NAME, TIKTOK_ADS_SKILL_MARKDOWN } from './tiktokAdsSkill'

const ISSUER = 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer/oauth'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

interface FetchLogEntry {
  url: string
  init?: RequestInit
}

function makeFetch(plan: {
  register?: () => Response
  token?: (body: string) => Response
  discoveryFail?: boolean
}): { fetch: TikTokFetch; log: FetchLogEntry[] } {
  const log: FetchLogEntry[] = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    log.push({ url, init })
    if (plan.discoveryFail && url.includes('.well-known/oauth-protected-resource')) {
      return jsonResponse({ error: 'not_found' }, 404)
    }
    if (url.includes('.well-known/oauth-protected-resource')) {
      return jsonResponse({ authorization_servers: [ISSUER], scopes_supported: ['mcp:tt4b'] })
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: 'https://business-api.tiktok.com/portal/mcp-tt4b-authorize',
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        scopes_supported: ['mcp:tt4b'],
        grant_types_supported: ['authorization_code', 'refresh_token']
      })
    }
    if (url === `${ISSUER}/register`) {
      return plan.register ? plan.register() : jsonResponse({ client_id: 'client-1' })
    }
    if (url === `${ISSUER}/token`) {
      return plan.token
        ? plan.token(String(init?.body ?? ''))
        : jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'mcp:tt4b' })
    }
    return jsonResponse({ error: 'unexpected' }, 500)
  }
  return { fetch, log }
}

async function driveCallback(authorizeUrl: string, overrides: { state?: string } = {}): Promise<Response> {
  const url = new URL(authorizeUrl)
  const port = Number(new URL(url.searchParams.get('redirect_uri') ?? '').port)
  const state = overrides.state ?? url.searchParams.get('state') ?? ''
  const query = new URLSearchParams({ code: 'auth-code-1', state })
  return fetch(`http://127.0.0.1:${port}/callback?${query.toString()}`)
}

let tempDirs: string[] = []

beforeEach(async () => {
  paths.documents = await mkdtemp(path.join(os.tmpdir(), 'toushou-tt-docs-'))
  paths.userData = await mkdtemp(path.join(os.tmpdir(), 'toushou-tt-user-'))
  tempDirs = [paths.documents, paths.userData]
})

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function makeManager(options: {
  fetch: TikTokFetch
  now?: () => number
}): { manager: TikTokAdsConnectionManager; openedUrls: string[] } {
  const openedUrls: string[] = []
  const manager = new TikTokAdsConnectionManager({
    credentialStore: new TikTokCredentialStore({
      filePath: path.join(paths.userData, 'tiktok-creds.bin'),
      backend: fakeBackend()
    }),
    mcpPaths: {
      mcpJson: path.join(paths.userData, 'mcp.json'),
      registry: path.join(paths.userData, 'mcp-registry.json')
    },
    fetchImpl: options.fetch,
    openExternal: async (url) => {
      openedUrls.push(url)
    },
    now: options.now ?? Date.now
  })
  return { manager, openedUrls }
}

function fakeBackend() {
  let envelope = ''
  return {
    isAvailable: () => true,
    encrypt: (value: string) => {
      envelope = `enc:${Buffer.from(value).toString('base64')}`
      return Buffer.from(envelope)
    },
    decrypt: (value: Buffer) => Buffer.from(value.toString('utf-8').replace(/^enc:/, ''), 'base64').toString('utf-8')
  }
}

describe('TikTokAdsConnectionManager connect flow', () => {
  it('walks discovery → registration → PKCE authorize → callback → connected, writing mcp + skill', async () => {
    const { fetch, log } = makeFetch({})
    const { manager, openedUrls } = makeManager({ fetch })

    const snapshot = await manager.begin()
    expect(snapshot.status).toBe('waiting_for_user')
    expect(openedUrls).toHaveLength(1)

    const authorize = new URL(openedUrls[0])
    expect(authorize.searchParams.get('response_type')).toBe('code')
    expect(authorize.searchParams.get('client_id')).toBe('client-1')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('code_challenge') ?? '').toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(authorize.searchParams.get('scope')).toBe('mcp:tt4b')
    expect(authorize.searchParams.get('resource')).toBe('https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer')

    const callbackResponse = await driveCallback(openedUrls[0])
    expect(callbackResponse.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const connected = manager.getSnapshot()
    expect(connected.connected).toBe(true)
    expect(connected.tokenExpiresAt).toBeGreaterThan(0)

    // Token exchange carried the verifier + redirect_uri + client_id.
    const tokenCall = log.find((entry) => entry.url === `${ISSUER}/token`)
    expect(tokenCall).toBeDefined()
    const body = new URLSearchParams(String(tokenCall?.init?.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code-1')
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    // The runtime entry owns exactly this server with the minted bearer.
    const mcpFile = JSON.parse(await readFile(path.join(paths.userData, 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(mcpFile.mcpServers['tiktok-ads']).toEqual({
      type: 'http',
      url: 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer',
      timeout: 120000,
      headers: { Authorization: 'Bearer at-1' }
    })
    const registry = JSON.parse(await readFile(path.join(paths.userData, 'mcp-registry.json'), 'utf-8')) as { managed: string[] }
    expect(registry.managed).toContain('tiktok-ads')

    // The bundled skill landed in the flat library folder.
    const skill = await readFile(path.join(paths.userData, 'skills', TIKTOK_ADS_SKILL_FILE_NAME), 'utf-8')
    expect(skill).toBe(TIKTOK_ADS_SKILL_MARKDOWN)

    // Credentials persist only as an encrypted envelope (base64 ciphertext —
    // the plaintext token never touches the file).
    const raw = await readFile(path.join(paths.userData, 'tiktok-creds.bin'), 'utf-8')
    expect(raw).toMatch(/^[A-Za-z0-9+/=\r\n]+$/)
    expect(raw).not.toContain('at-1')
    expect(raw).not.toContain('rt-1')
  })

  it('rejects a callback whose state does not match (no token exchange)', async () => {
    const { fetch, log } = makeFetch({})
    const { manager, openedUrls } = makeManager({ fetch })
    await manager.begin()

    const response = await driveCallback(openedUrls[0], { state: 'tampered-state' })
    expect(response.status).toBe(400)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(manager.getSnapshot().status).toBe('failed')
    expect(log.some((entry) => entry.url === `${ISSUER}/token`)).toBe(false)
  })

  it('surfaces a discovery failure instead of hanging', async () => {
    const { fetch } = makeFetch({ discoveryFail: true })
    const { manager } = makeManager({ fetch })
    const snapshot = await manager.begin()
    expect(snapshot.status).toBe('failed')
    expect(snapshot.lastError ?? '').toContain('OAuth')
  })

  it('tries both loopback redirect shapes when registration rejects the first', async () => {
    let calls = 0
    const { fetch, log } = makeFetch({
      register: () => {
        calls += 1
        return calls === 1
          ? jsonResponse({ error: 'invalid_redirect_uri', error_description: 'redirect uri not allowed' }, 400)
          : jsonResponse({ client_id: 'client-2' })
      }
    })
    const { manager, openedUrls } = makeManager({ fetch })
    const snapshot = await manager.begin()
    expect(snapshot.status).toBe('waiting_for_user')
    expect(calls).toBe(2)
    const registerBodies = log
      .filter((entry) => entry.url === `${ISSUER}/register`)
      .map((entry) => JSON.parse(String(entry.init?.body)))
    expect(registerBodies[0].redirect_uris[0]).toBe('http://127.0.0.1/callback')
    expect(registerBodies[1].redirect_uris[0]).toBe('http://localhost/callback')
    expect(new URL(openedUrls[0]).searchParams.get('client_id')).toBe('client-2')
  })
})

describe('TikTokAdsConnectionManager lifecycle', () => {
  it('initialize restores a stored connection and self-heals the mcp entry', async () => {
    const { fetch } = makeFetch({})
    const mcpJson = path.join(paths.userData, 'mcp.json')
    const registry = path.join(paths.userData, 'mcp-registry.json')
    await mkdir(path.dirname(mcpJson), { recursive: true })
    await writeFile(mcpJson, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://example.com' } } }))
    await writeFile(registry, JSON.stringify({ managed: [] }))

    // Store credentials directly through the store the manager will load.
    const store = new TikTokCredentialStore({
      filePath: path.join(paths.userData, 'tiktok-creds.bin'),
      backend: fakeBackend()
    })
    await store.save({
      clientId: 'client-1',
      tokenEndpoint: `${ISSUER}/token`,
      accessToken: 'restored-token',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
      scope: 'mcp:tt4b'
    })

    const manager = new TikTokAdsConnectionManager({
      credentialStore: store,
      mcpPaths: { mcpJson, registry },
      fetchImpl: fetch,
      openExternal: async () => undefined
    })
    await manager.initialize()

    const snapshot = manager.getSnapshot()
    expect(snapshot.connected).toBe(true)
    const file = JSON.parse(await readFile(mcpJson, 'utf-8')) as { mcpServers: Record<string, unknown> }
    // Self-heal adds tiktok-ads without touching the foreign entry.
    expect(file.mcpServers.other).toEqual({ type: 'http', url: 'https://example.com' })
    expect((file.mcpServers['tiktok-ads'] as { headers: { Authorization: string } }).headers.Authorization).toBe('Bearer restored-token')
  })

  it('refreshes an expiring token via the persisted endpoint and rewrites the entry', async () => {
    let nowMs = 1_000_000
    const { fetch, log } = makeFetch({
      token: (body) =>
        body.includes('grant_type=refresh_token')
          ? jsonResponse({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 7200 })
          : jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1 })
    })
    const { manager, openedUrls } = makeManager({ fetch, now: () => nowMs })
    await manager.begin()
    await driveCallback(openedUrls[0])
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Exchange issued expires_in=1s.
    // Advance past the margin: refresh must run.
    nowMs += 10_000

    const refreshed = await manager.ensureFreshToken()
    expect(refreshed).toBe(true)
    const refreshCall = log.find((entry) => entry.url === `${ISSUER}/token` && String(entry.init?.body).includes('refresh_token'))
    expect(refreshCall).toBeDefined()
    const body = new URLSearchParams(String(refreshCall?.init?.body))
    expect(body.get('refresh_token')).toBe('rt-1')
    expect(body.get('client_id')).toBe('client-1')

    const mcpFile = JSON.parse(await readFile(path.join(paths.userData, 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { headers: { Authorization: string } }>
    }
    expect(mcpFile.mcpServers['tiktok-ads'].headers.Authorization).toBe('Bearer at-2')
    expect(manager.getSnapshot().connected).toBe(true)
  })

  it('a far-from-expiry token schedules instead of fetching', async () => {
    const { fetch, log } = makeFetch({})
    const { manager, openedUrls } = makeManager({ fetch })
    await manager.begin()
    await driveCallback(openedUrls[0])
    await new Promise((resolve) => setTimeout(resolve, 50))
    const before = log.length
    const ok = await manager.ensureFreshToken()
    expect(ok).toBe(true)
    expect(log.length).toBe(before)
    expect(manager.getSnapshot().connected).toBe(true)
  })

  it('a failed refresh degrades loudly', async () => {
    let nowMs = 1_000_000
    const { fetch } = makeFetch({
      token: (body) =>
        body.includes('grant_type=refresh_token')
          ? jsonResponse({ error: 'invalid_grant' }, 400)
          : jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1 })
    })
    const { manager, openedUrls } = makeManager({ fetch, now: () => nowMs })
    await manager.begin()
    await driveCallback(openedUrls[0])
    await new Promise((resolve) => setTimeout(resolve, 50))
    nowMs += 10_000
    const ok = await manager.ensureFreshToken()
    expect(ok).toBe(false)
    const snapshot = manager.getSnapshot()
    expect(snapshot.status).toBe('degraded')
    expect(snapshot.lastError ?? '').toContain('令牌刷新失败')
  })

  it('disconnect removes the mcp entry and clears credentials', async () => {
    const { fetch } = makeFetch({})
    const { manager, openedUrls } = makeManager({ fetch })
    await manager.begin()
    await driveCallback(openedUrls[0])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.getSnapshot().connected).toBe(true)

    const snapshot = await manager.disconnect()
    expect(snapshot.connected).toBe(false)
    const mcpFile = JSON.parse(await readFile(path.join(paths.userData, 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(mcpFile.mcpServers['tiktok-ads']).toBeUndefined()
    const raw = await readFile(path.join(paths.userData, 'tiktok-creds.bin'), 'utf-8').catch(() => '')
    expect(raw).toBe('')
  })
})
