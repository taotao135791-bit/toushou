const { app, BrowserWindow } = require('electron')
const path = require('node:path'), fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: true, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    await win.loadFile(path.join(dir, 'index.html'))
    const wc = win.webContents
    const wait = () => new Promise(resolve => setTimeout(resolve, 150))
    const read = () => wc.executeJavaScript(`({ rows:[...document.querySelectorAll('[data-qa-table] tbody tr')].map(row=>[...row.querySelectorAll('td')].map(cell=>cell.innerText)), table:document.querySelector('[data-qa-table]').innerText, stageLabels:[...document.querySelectorAll('[data-qa-funnel] li')].map(stage=>stage.querySelector('span').innerText), stages:[...document.querySelectorAll('[data-qa-funnel] li')].map(stage=>stage.innerText) })`)
    await wait()
    const first = await read()
    await wc.executeJavaScript(`document.querySelector('button[aria-label="Next page"]').click()`); await wait()
    const next = await read()
    await wc.executeJavaScript(`[...document.querySelectorAll('[data-qa-table] th button')].find(button=>button.textContent==='Count').click()`); await wait()
    const sorted = await read()
    await wc.executeJavaScript(`document.getElementById('day-2').click()`); await wait()
    const secondDay = await read()
    await wc.executeJavaScript(`document.getElementById('new-data').click()`); await wait()
    const refreshed = await read()
    await wc.executeJavaScript(`document.getElementById('fail-source').click()`); await wait()
    const failed = await read()
    await wc.executeJavaScript(`document.getElementById('day-empty').click()`); await wait()
    const empty = await read()
    console.log('E2E_RESULT ' + JSON.stringify({ first, next, sorted, secondDay, refreshed, failed, empty }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), stack: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
