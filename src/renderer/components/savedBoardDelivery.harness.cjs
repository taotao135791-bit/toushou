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
    const wc = win.webContents, wait = () => new Promise(resolve => setTimeout(resolve, 150))
    const read = () => wc.executeJavaScript(`({count:document.querySelectorAll('section[aria-label="Board result"]').length,text:document.querySelector('section[aria-label="Board result"]')?.innerText,iframes:document.querySelectorAll('iframe').length,listCalls:window.deliveryFixture.listCalls,checks:window.deliveryFixture.checks})`)
    await wait()
    const unavailable = await read()
    await wc.executeJavaScript(`document.getElementById('restore').click()`); await wait()
    const ready = await read()
    await wc.executeJavaScript(`document.querySelector('section[aria-label="Board result"] button').click()`); await wait()
    const route = await wc.executeJavaScript(`document.getElementById('route').innerText`)
    console.log('E2E_RESULT ' + JSON.stringify({ unavailable, ready, route }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), stack: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
