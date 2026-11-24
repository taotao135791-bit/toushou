const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root" style="height:100vh"></div><script src="fixture.js"></script>')
    win = new BrowserWindow({ show: true, focusable: process.env.TOUSHOU_E2E_UNFOCUSED !== '1', width: 1100, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    const wc = win.webContents
    await win.loadFile(path.join(dir, 'index.html'))
    const js = code => wc.executeJavaScript(code)
    const waitFor = async code => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 50)) } throw new Error('Timed out: ' + code) }
    const click = text => js(`[...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})?.click()`)
    const calls = () => js('window.fbFixture.calls.map(c=>c.act)')
    await waitFor(`document.querySelector('[aria-label="选择 Facebook 读取范围"] [role="option"]')`)
    const initial = { calls: await calls(), articles: await js('document.querySelectorAll("article").length') }
    const text = await js('document.body.innerText')
    const fb = '[aria-label="选择 Facebook 读取范围"]'
    const fbClick = text => js(`[...document.querySelectorAll('${fb} button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})?.click()`)
    await js(`document.querySelector('${fb} [role="option"]').click()`)
    await fbClick('读取此账户')
    await waitFor('document.querySelectorAll("article").length === 1')
    const single = await js('window.metaFixture.calls.map(c => c.accountId)')
    await click('近28天')
    await waitFor(`document.querySelector('${fb} [role="option"]')`)
    const clearedOnDate = await js('document.querySelectorAll("article").length === 0')
    await fbClick('巡检全部已授权账户')
    await waitFor('document.querySelectorAll("article").length === 3')
    const windows = await js('window.metaFixture.calls.slice(1).map(c => c.window)')
    await js('window.metaFixture.fail = "act_234567"')
    await fbClick('巡检全部已授权账户')
    await waitFor('document.body.innerText.includes("Synthetic quota exhausted")')
    const stoppedOnFailure = await js('window.metaFixture.calls.slice(4).map(c => c.accountId).join() === "act_123456,act_234567" && document.querySelectorAll("article").length === 1')
    await js('window.metaFixture.partial = true')
    await fbClick('重新获取账户')
    await waitFor('document.body.innerText.includes("账户列表尚有分页")')
    const partialDisabled = await js(`[...document.querySelectorAll('${fb} button')].find(e => e.textContent.trim() === '巡检全部已授权账户').disabled`)
    await js('window.metaFixture.partial = false; window.metaFixture.fail = ""; window.metaFixture.hold = true')
    await fbClick('重新获取账户')
    await waitFor(`document.querySelector('${fb} [role="option"]')`)
    await js(`document.querySelector('${fb} [role="option"]').click()`)
    await fbClick('读取此账户')
    await waitFor('!!window.metaFixture.release')
    await js('window.metaFixture.listener({ connected: false }); window.metaFixture.release()')
    await waitFor(`document.querySelector('${fb} [role="option"]')`)
    const lateIgnored = await js('document.querySelectorAll("article").length === 0')
    const after = await calls()
    console.log('E2E_RESULT ' + JSON.stringify({ initial, text, after, single, clearedOnDate, windows, stoppedOnFailure, partialDisabled, lateIgnored }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
