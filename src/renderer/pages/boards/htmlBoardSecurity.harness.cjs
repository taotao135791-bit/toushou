const { app, BrowserWindow, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'electron-user-data'))
app.whenReady().then(async () => {
  let win
  let phase = 'start'
  try {
    const partition = session.fromPartition('html-board-security-test')
    const requests = []
    partition.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      requests.push(details.url)
      callback({ cancel: true })
    })
    win = new BrowserWindow({ show: false, webPreferences: { session: partition, contextIsolation: true, sandbox: true, nodeIntegration: false } })
    // Verify interception itself before claiming that no requests escaped.
    try { await win.loadURL('http://127.0.0.1:48767/network-monitor-probe') } catch { /* intentionally cancelled */ }
    const monitorWorked = requests.some(value => value.includes('/network-monitor-probe'))
    requests.length = 0
    phase = 'direct-file'
    await win.loadFile(path.join(dir, 'export.html'))
    // Use Chromium's DOM inspector for read-only checks without weakening the
    // exported page's script policy.
    win.webContents.debugger.attach('1.3')
    const send = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await send('DOM.enable')
    await send('CSS.enable')
    const documentRoot = (await send('DOM.getDocument', { depth: -1, pierce: true })).root.nodeId
    const query = async selector => (await send('DOM.querySelector', { nodeId: documentRoot, selector })).nodeId
    const table = await query('main table')
    const custom = await query('.probe')
    const root = await query('html')
    const styleOf = async nodeId => (await send('CSS.getComputedStyleForNode', { nodeId })).computedStyle
    const tableStyle = table ? await styleOf(table) : []
    const customStyle = custom ? await styleOf(custom) : []
    const html = (await send('DOM.getOuterHTML', { nodeId: root })).outerHTML
    let tableHasBox = false
    try { const box = await send('DOM.getBoxModel', { nodeId: table }); tableHasBox = box.model.height > 0 } catch { /* hidden/missing */ }
    const direct = { tableVisible: !!table && tableHasBox && tableStyle.find(item => item.name === 'display')?.value !== 'none',
      customHidden: !!custom && customStyle.find(item => item.name === 'display')?.value === 'none',
      anonymous: html.includes('Account 1') && !html.includes('SECRET_NAME') && !html.includes('SECRET_ID'),
      noSvg: !(await query('svg')), noScripts: !(await query('script')) }

    // Add a synthetic inline script to a copy solely to verify the exported
    // CSP in Chromium. The original export has no script at all.
    phase = 'csp-probe'
    const source = readFileSync(path.join(dir, 'export.html'), 'utf8')
    const probe = path.join(dir, 'csp-probe.html')
    writeFileSync(probe, source.replace('</body>', `<script>document.body.setAttribute('data-script-ran','yes');fetch('http://127.0.0.1:48767/export-probe')</script></body>`))
    await win.loadFile(probe)
    const probeRoot = (await send('DOM.getDocument', { depth: -1, pierce: true })).root.nodeId
    const bodyId = (await send('DOM.querySelector', { nodeId: probeRoot, selector: 'body' })).nodeId
    const attributes = (await send('DOM.getAttributes', { nodeId: bodyId })).attributes
    const cspScriptBlocked = !attributes.includes('data-script-ran')
    win.webContents.debugger.detach()

    // Exercise the editor's opaque-origin, fully sandboxed srcdoc boundary.
    const host = path.join(dir, 'host.html')
    writeFileSync(host, '<!doctype html><html><body>host</body></html>')
    await win.loadFile(host)
    phase = 'sandbox-frame'
    await win.webContents.executeJavaScript(`new Promise(resolve => { const frame = document.createElement('iframe'); frame.setAttribute('sandbox', ''); frame.onload = resolve; frame.srcdoc = ${JSON.stringify(source)}; document.body.appendChild(frame) })`)
    const child = win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
    if (!child) throw new Error('sandboxed preview frame was not created')
    const frame = await win.webContents.executeJavaScript(`(() => {const f=document.querySelector('iframe');return {sandboxEmpty:f.getAttribute('sandbox')==='',sameContent:f.srcdoc===${JSON.stringify(source)}}})()`)
    let frameScriptBlocked = false
    try { await child.executeJavaScript('parent.__security_probe = true') } catch { frameScriptBlocked = true }
    await new Promise(resolve => setTimeout(resolve, 300))
    process.stdout.write(`E2E_RESULT ${JSON.stringify({ monitorWorked, direct, frame, cspScriptBlocked, frameScriptBlocked, networkRequests: requests })}\n`)
  } catch (error) {
    process.stdout.write(`E2E_RESULT ${JSON.stringify({ fatal: error instanceof Error ? error.message : String(error), phase })}\n`)
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    app.quit()
  }
}).catch(error => { process.stdout.write(`E2E_RESULT ${JSON.stringify({ fatal: String(error) })}\n`); app.quit() })
