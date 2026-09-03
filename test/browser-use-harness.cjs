/**
 * Real-Electron E2E harness for the browser-use bridge (review request on
 * PR #8: real panel + multi-session concurrency). Run by
 * browserUse.e2e.test.ts as: electron browser-use-harness.cjs <modules.cjs>
 *
 * The harness boots a hidden BrowserWindow, a real WebContentsView browser
 * panel loaded from a local fixture server, the loopback bridge, and two
 * per-session tokens — then drives the bridge exactly like the bundled
 * extension tools would (plain fetch) and prints one JSON verdict line.
 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const path = require('node:path')

const INDEX_HTML = `<!doctype html><html><head><title>fixture-index</title></head><body>
<main>
  <h1>fixture main heading</h1>
  <p id="marker">snapshot-source-marker</p>
  <a id="link2" href="/page2">go page two</a>
  <form action="/searched" method="get"><input id="q" name="q" placeholder="type here"><button id="go" type="submit">Search</button></form>
</main></body></html>`

const PAGE2_HTML = `<!doctype html><html><head><title>fixture-page2</title></head><body><main><h1>second page</h1></main></body></html>`

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url.startsWith('/page2') ? PAGE2_HTML : req.url.startsWith('/searched') ? '<main>search results</main>' : INDEX_HTML)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.json()
}

app.whenReady().then(async () => {
  const out = { steps: [] }
  const record = (name, result) => out.steps.push({ name, result })
  try {
    const { server, port } = await startFixtureServer()
    const base = `http://127.0.0.1:${port}`
    const use = require(path.resolve(process.argv[2], 'browserUse.js'))
    const panels = require(path.resolve(process.argv[2], 'browserPanel.js'))
    const win = new BrowserWindow({ show: false, width: 800, height: 600 })

    // User-visible start: the panel is attached and shows the fixture page.
    panels.showBrowserPanel(win, { x: 0, y: 0, width: 640, height: 480 }, `${base}/`)
    await new Promise((r) => setTimeout(r, 400))

    use.initBrowserUseBridge()
    // Give the loopback listener a beat, then mint two session credentials.
    await new Promise((r) => setTimeout(r, 200))
    const envA = use.browserUseEnv('session-A')['TOUSHOU_BROWSER_USE']
    const envB = use.browserUseEnv('session-B')['TOUSHOU_BROWSER_USE']
    if (!envA || !envB) throw new Error('bridge did not start')

    // 1. A navigates: ownership transfers to A, visibly.
    record('A navigate', await post(envA, { action: 'navigate', url: `${base}/` }))

    // 2. A reads the source snapshot: text + elements with refs.
    const snap = await post(envA, { action: 'snapshot' })
    record('A snapshot', snap)

    // 3. B tries to act on A's page: denied with the ownership error.
    record('B snapshot (expect denial)', await post(envB, { action: 'snapshot' }))

    // 4. A types into the search box and submits; the GET form navigates.
    const input = (snap.elements || []).find((e) => e.tag === 'input')
    if (!input) throw new Error('snapshot did not expose the input element')
    record('A type+submit', await post(envA, { action: 'type', ref: input.ref, text: '投手', submit: true }))
    const afterSearch = await post(envA, { action: 'snapshot' })
    record('A snapshot after search', afterSearch)

    // 5. A clicks the link (real mouse events) — back to index first.
    await post(envA, { action: 'navigate', url: `${base}/` })
    const snap2 = await post(envA, { action: 'snapshot' })
    const link = (snap2.elements || []).find((e) => e.tag === 'a')
    record('A click link', await post(envA, { action: 'click', ref: link.ref }))
    record('A snapshot after click', await post(envA, { action: 'snapshot' }))

    // 6. Screenshot fallback: file lands on disk. capturePage needs the
    //    window actually painted, so surface the hidden window for this step
    //    (in the real app the window is visible by definition).
    win.show()
    await new Promise((r) => setTimeout(r, 250))
    record('A screenshot', await post(envA, { action: 'screenshot' }))
    win.hide()

    // 7. User hides the panel: further actions must fail with panel-hidden.
    panels.hideBrowserPanel(win)
    record('A snapshot while hidden (expect denial)', await post(envA, { action: 'snapshot' }))

    // 8. A navigate on a hidden panel is allowed (it reopens visibly via the
    //    renderer flow); the harness re-attaches like the renderer would.
    const nav = await post(envA, { action: 'navigate', url: `${base}/page2` })
    panels.showBrowserPanel(win, { x: 0, y: 0, width: 640, height: 480 })
    record('A navigate while hidden (reopens)', nav)

    // 9. B takes ownership by navigating; A now loses acting rights.
    record('B navigate (takeover)', await post(envB, { action: 'navigate', url: `${base}/` }))
    record('A snapshot after takeover (expect denial)', await post(envA, { action: 'snapshot' }))

    // 10. Unknown token is rejected outright.
    let forbidden = false
    try {
      const res = await fetch(`${envA.slice(0, envA.lastIndexOf('/'))}/deadbeef`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'snapshot' })
      })
      forbidden = res.status === 403
    } catch {
      forbidden = false
    }
    record('unknown token (expect 403)', { ok: forbidden })

    server.close()
    app.exit(0)
    process.stdout.write(`E2E_RESULT ${JSON.stringify(out)}\n`)
  } catch (err) {
    process.stdout.write(`E2E_RESULT ${JSON.stringify({ fatal: String(err) })}\n`)
    app.exit(1)
  }
})
