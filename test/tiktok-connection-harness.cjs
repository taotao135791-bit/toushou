/** Real Electron transport with localhost-only synthetic data; no real accounts or UI. */
const { app } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(process.argv[2])
const profile = path.join(root, 'profile')
fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
app.setPath('userData', profile)
app.setPath('sessionData', profile)

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
async function waitFor(check) {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Synthetic authorization did not finish')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

app.whenReady().then(async () => {
  let manager, server
  try {
    const modules = require(path.join(root, 'modules.cjs'))
    let authorizationUrl = '', exchanges = 0, loads = 0
    const credentialStore = new modules.TikTokCredentialStore({
      filePath: path.join(profile, 'synthetic-credentials.bin'),
      // Explicit fake backend prevents all native keychain access in this fixture.
      backend: { isAvailable: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString('utf8') }
    })
    const issuer = 'https://oauth.synthetic.invalid'
    manager = new modules.TikTokAdsConnectionManager({
      credentialStore,
      mcpPaths: { mcpJson: path.join(profile, 'oauth-mcp.json'), registry: path.join(profile, 'oauth-registry.json') },
      openExternal: async url => { authorizationUrl = url },
      fetchImpl: async (url, init) => {
        if (url.includes('/.well-known/oauth-protected-resource/')) return json({ authorization_servers: [issuer], scopes_supported: ['mcp:tt4b'] })
        if (url === `${issuer}/.well-known/oauth-authorization-server`) return json({ authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register` })
        if (url === `${issuer}/register`) return json({ client_id: 'synthetic-client' })
        if (url === `${issuer}/token`) {
          const body = new URLSearchParams(String(init.body))
          assert.equal(body.get('code'), 'synthetic-code')
          assert.equal(body.get('grant_type'), 'authorization_code')
          exchanges++
          return json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600 })
        }
        throw new Error('Unexpected synthetic OAuth request')
      }
    })
    modules.setTikTokOAuthCredentialLoader(async () => { loads++; return manager.loadFreshCredentials() }, () => manager.hasOAuthCredentials())
    const reports = new modules.TikTokRefreshService({
      credentialsFile: path.join(profile, 'absent-legacy.json'),
      datasetsFile: path.join(profile, 'synthetic-dataset.json'),
      settings: { getAutoRefresh: () => false, setAutoRefresh: () => {} },
      broadcast: () => {}, onDatasetCommitted: () => {}
    })
    assert.equal(reports.getStatus().configured, false)
    assert.equal((await manager.begin()).status, 'waiting_for_user')
    const authorize = new URL(authorizationUrl)
    const redirect = new URL(authorize.searchParams.get('redirect_uri'))
    assert.equal((await fetch(`${redirect.origin}/favicon.ico`)).status, 204)
    assert.equal((await fetch(`${redirect.origin}/unrelated`)).status, 404)
    assert.equal((await fetch(`${redirect.origin}/callback?state=wrong&code=synthetic-code`)).status, 400)
    assert.equal((await fetch(`${redirect.origin}/callback`, { method: 'POST' })).status, 405)
    assert.equal(manager.getSnapshot().status, 'waiting_for_user')
    assert.equal(exchanges, 0)
    redirect.search = new URLSearchParams({ code: 'synthetic-code', state: authorize.searchParams.get('state') }).toString()
    assert.equal((await fetch(redirect)).status, 200)
    await waitFor(() => manager.getSnapshot().connected)
    assert.equal(exchanges, 1)
    assert.equal(reports.getStatus().configured, true)
    assert.equal(reports.getStatus().info.configured, false)
    assert.equal(loads, 0)

    const seen = []
    server = http.createServer(async (req, res) => {
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        seen.push({ method: rpc.method, path: req.url })
        assert.equal(req.headers.authorization, 'Bearer synthetic-probe-token')
        assert.equal(req.method, 'POST')
        res.setHeader('content-type', 'application/json')
        if (rpc.method === 'initialize') {
          assert.equal(rpc.params.protocolVersion, '2025-03-26')
          res.setHeader('Mcp-Session-Id', 'synthetic-session')
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } } }))
          return
        }
        assert.equal(req.headers['mcp-session-id'], 'synthetic-session')
        assert.equal(req.headers['mcp-protocol-version'], '2025-03-26')
        if (rpc.method === 'notifications/initialized') {
          assert.equal(rpc.id, undefined)
          res.writeHead(202); res.end(); return
        }
        assert.equal(rpc.method, 'tools/list')
        if (req.url === '/failure') { res.writeHead(503); res.end('synthetic failure'); return }
        const result = rpc.params.cursor === 'next-synthetic-page'
          ? { tools: [{ name: 'second_synthetic_read' }] }
          : { tools: [{ name: 'first_synthetic_read' }], nextCursor: 'next-synthetic-page' }
        if (rpc.params.cursor) {
          res.setHeader('content-type', 'text/event-stream')
          res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`)
        } else res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      } catch {
        res.writeHead(400); res.end('synthetic protocol violation')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${server.address().port}`
    const paths = { mcpJson: path.join(profile, 'probe-mcp.json'), registry: path.join(profile, 'probe-registry.json') }
    fs.writeFileSync(paths.mcpJson, JSON.stringify({ mcpServers: {
      good: { type: 'http', url: `${endpoint}/good`, headers: { Authorization: 'Bearer synthetic-probe-token' } },
      failure: { type: 'http', url: `${endpoint}/failure`, headers: { Authorization: 'Bearer synthetic-probe-token' } }
    } }), { mode: 0o600 })
    const good = await modules.testMcpConnection('good', paths)
    assert.equal(good.ok, true)
    assert.ok(good.detail.includes('2'))
    const failed = await modules.testMcpConnection('failure', paths)
    assert.equal(failed.ok, false)
    assert.ok(failed.detail.includes('503'))
    assert.deepEqual(seen.filter(row => row.path === '/good').map(row => row.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
    assert.ok(seen.every(row => row.method !== 'tools/call'))
    console.log('E2E_RESULT ' + JSON.stringify({ unrelatedCallbacksPreserved: true, oauthConnected: true, oauthOnlyStatusConfigured: true, statusDidNotLoadCredentials: true, mcpHandshakeAndPagination: true, mcpFailureRejected: true, businessToolsCalled: false, nativeKeychainUsed: false }))
  } catch (error) {
    console.log('E2E_RESULT ' + JSON.stringify({ fatal: error instanceof Error ? error.message : 'Synthetic fixture failed' }))
  } finally {
    if (manager) await manager.disconnect().catch(() => {})
    if (server) server.close()
    app.exit(0)
  }
}).catch(() => { console.log('E2E_RESULT ' + JSON.stringify({ fatal: 'Electron fixture initialization failed' })); app.exit(1) })
