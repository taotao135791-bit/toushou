const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root" style="height:100vh"></div><script src="fixture.js"></script>')
    win = new BrowserWindow({ show: true, width: 1100, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    const wc = win.webContents
    await win.loadFile(path.join(dir, 'index.html'))
    const js = code => wc.executeJavaScript(code)
    const waitFor = async code => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 50)) } throw new Error('Timed out: ' + code) }
    const click = text => js(`[...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})?.click()`)
    const calls = () => js('window.fbFixture.calls.map(c=>c.act)')
    await waitFor(`document.body.textContent.includes('前往 Meta Ads 连接')`)
    const initial = { calls: await calls(), articles: await js('document.querySelectorAll("article").length') }
    const text = await js('document.body.innerText')
    await click('前往 Meta Ads 连接')
    const after = await calls()
    console.log('E2E_RESULT ' + JSON.stringify({ initial, text, after }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
