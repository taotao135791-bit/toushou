const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root" style="height:100vh"></div><script src="fixture.js"></script>')
    // 测试窗口一律放副屏（用户要求：绝不占主屏）；没有副屏才回退主屏。
const e2eScreen = require('electron').screen
const e2eSecondary = (() => {
  try {
    return e2eScreen.getAllDisplays().find(d => d.id !== e2eScreen.getPrimaryDisplay().id) ?? null
  } catch { return null }
})()
const e2ePlace = e2eSecondary ? { x: e2eSecondary.workArea.x + 24, y: e2eSecondary.workArea.y + 24 } : {}
    win = new BrowserWindow({ ...e2ePlace, show: true, focusable: process.env.TOUSHOU_E2E_UNFOCUSED !== '1', width: 1100, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    const wc = win.webContents
    await win.loadFile(path.join(dir, 'index.html'))
    const js = code => wc.executeJavaScript(code)
    const waitFor = async code => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 50)) } throw new Error('Timed out: ' + code) }
    const click = text => js(`[...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})?.click()`)
    const calls = () => js('window.fbFixture.calls.map(c=>c.act)')
    await waitFor(`document.body.textContent.includes('前往连接页设置 Meta Ads')`)
    const initial = { calls: await calls(), articles: await js('document.querySelectorAll("article").length') }
    const text = await js('document.body.innerText')
    await click('前往连接页设置 Meta Ads')
    const after = await calls()
    console.log('E2E_RESULT ' + JSON.stringify({ initial, text, after }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
