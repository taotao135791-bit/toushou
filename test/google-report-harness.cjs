/** Real Electron, a localhost-only synthetic Google-like page, no real accounts. */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// The fixture must never share cookies, credentials or browser state with an installed app.
const userData = path.join(process.argv[2], 'profile')
fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
app.setPath('userData', userData)

const html = `<!doctype html><meta charset="utf-8"><title>Mock ads report</title>
<header><button>Demo 123-456-7890</button><button>2026年10月29日 不适用</button></header>
<button aria-label="下载" onclick="window.graphClicked = true">图表下载</button>
<section><div role="toolbar" aria-label="广告系列的主要工具条"><button aria-label="下载" onclick="document.querySelector('#menu').hidden = false">表格下载</button></div>
<table><tr><th>广告系列</th><th>费用</th><th>转化价值</th></tr><tr><td>Demo</td><td id="cost">US$9.00</td><td>US$8.00</td></tr></table><div>GMT+00</div></section>
<div id="menu" role="menu" hidden><button role="menuitem" onclick="location.href='/report.csv'">CSV</button></div>`
const csv = 'Campaign,Cost,Clicks\nDemo,US$9.00,3\nTotal: Campaigns,US$9.00,3\n'

app.whenReady().then(async () => {
  let server
  let win
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-report-e2e-'))
  try {
    const page = require(path.join(process.argv[2], 'googleReportPage.js'))
    const report = require(path.join(process.argv[2], 'googleReport.js'))
    server = http.createServer((req, res) => {
      if (req.url === '/report.csv') {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' })
        res.end(csv)
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
    const wc = win.webContents
    const evidence = await wc.executeJavaScript(page.PAGE_EVIDENCE_SCRIPT)
    const context = page.parseGooglePageEvidence(evidence)
    if (!context) throw new Error('context not found')
    const file = path.join(dir, 'report.csv')
    const download = new Promise((resolve, reject) => {
      wc.session.once('will-download', (_event, item, origin) => {
        if (origin !== wc) return reject(new Error('wrong download source'))
        item.setSavePath(file)
        item.once('done', (_event, state) => state === 'completed' ? resolve() : reject(new Error('download failed')))
      })
    })
    for (const [labels, toolbar] of [[['download', '下载'], true], [['csv'], false]]) {
      const point = await wc.executeJavaScript(page.buildGoogleExportLocator(labels, toolbar))
      if (!point) throw new Error('control not found')
      const x = Math.round(point.x), y = Math.round(point.y)
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await Promise.race([download, new Promise((_, reject) => setTimeout(() => reject(new Error('download timed out')), 5000))])
    const outcome = report.parseGoogleReportCsv(fs.readFileSync(file, 'utf8'), context)
    const graphClicked = await wc.executeJavaScript('Boolean(window.graphClicked)')
    await wc.executeJavaScript("document.querySelector('#cost').textContent = '¥9.00'")
    const wrongColumnEvidence = await wc.executeJavaScript(page.PAGE_EVIDENCE_SCRIPT)
    const wrongColumn = page.parseGooglePageEvidence(wrongColumnEvidence)
    console.log('E2E_RESULT ' + JSON.stringify({ context, graphClicked, verified: outcome.verification.verified, spend: outcome.summary?.accounts[0]?.spend, wrongColumn }))
  } catch (error) {
    console.log('E2E_RESULT ' + JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) }))
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    if (server) server.close()
    fs.rmSync(dir, { recursive: true, force: true })
    // Parent test removes this profile after Electron exits (Windows keeps profile files open).
    app.exit(0)
  }
}).catch(error => { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error) })); app.exit(1) })
