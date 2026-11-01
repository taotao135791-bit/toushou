const { app, BrowserWindow, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'electron-user-data'))
const inspect = `(() => {
  const table = document.querySelector('main table');
  const custom = document.querySelector('.probe');
  const visible = node => !!node && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
  let parentBlocked = false;
  try { void parent.document.body } catch { parentBlocked = true }
  return { tableVisible: visible(table), customHidden: !!custom && getComputedStyle(custom).display === 'none',
    anonymous: document.body.textContent.includes('Account 1') && !document.documentElement.outerHTML.includes('SECRET_NAME') && !document.documentElement.outerHTML.includes('SECRET_ID'),
    noSvg: !document.querySelector('svg'), noScripts: !document.querySelector('script'),
    parentBlocked, noNode: typeof require === 'undefined' && typeof process === 'undefined' };
})()`

app.whenReady().then(async () => {
  let win
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
    await win.loadFile(path.join(dir, 'export.html'))
    const direct = await win.webContents.executeJavaScript(inspect)
    const directFetchBlocked = await win.webContents.executeJavaScript(`fetch('http://127.0.0.1:48767/export-probe').then(() => false, () => true)`)

    // Exercise the editor's opaque-origin, fully sandboxed srcdoc boundary.
    const host = path.join(dir, 'host.html')
    writeFileSync(host, '<!doctype html><html><body>host</body></html>')
    await win.loadFile(host)
    const html = readFileSync(path.join(dir, 'export.html'), 'utf8')
    await win.webContents.executeJavaScript(`new Promise(resolve => { const frame = document.createElement('iframe'); frame.setAttribute('sandbox', ''); frame.onload = resolve; frame.srcdoc = ${JSON.stringify(html)}; document.body.appendChild(frame) })`)
    const child = win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
    if (!child) throw new Error('sandboxed preview frame was not created')
    const frame = await child.executeJavaScript(inspect)
    const frameFetchBlocked = await child.executeJavaScript(`fetch('http://127.0.0.1:48767/frame-probe').then(() => false, () => true)`)
    await new Promise(resolve => setTimeout(resolve, 300))
    process.stdout.write(`E2E_RESULT ${JSON.stringify({ monitorWorked, direct, frame, directFetchBlocked, frameFetchBlocked, networkRequests: requests })}\n`)
  } catch (error) {
    process.stdout.write(`E2E_RESULT ${JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) })}\n`)
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    app.quit()
  }
}).catch(error => { process.stdout.write(`E2E_RESULT ${JSON.stringify({ fatal: String(error) })}\n`); app.quit() })
