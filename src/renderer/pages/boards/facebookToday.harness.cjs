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
    await waitFor(`document.body.textContent.includes('Fixture Alpha')`)
    const initial = { calls: await calls(), articles: await js('document.querySelectorAll("article").length') }
    await js(`document.querySelector('input[type=radio][value="123456"]').click()`)
    await click('读取此账户')
    await waitFor(`document.body.textContent.includes('已处理 1 / 1') && !document.body.textContent.includes(' · Fixture Alpha')`)
    const single = { calls: await calls(), articles: await js('document.querySelectorAll("article").length'), text: await js('document.querySelector("article").innerText') }
    // Filter the picker; inspecting all must still read every registered account.
    await js(`(() => { const e = document.querySelector('input[type=search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Alpha'); e.dispatchEvent(new Event('input',{bubbles:true})); window.fbFixture.fail='234567' })()`)
    const searchClearedSelection = await js(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='读取此账户').disabled`)
    await click('巡检全部已添加账户（3）')
    await waitFor(`document.body.textContent.includes('已处理 3 / 3')`)
    const batch = { calls: await calls(), articles: await js('document.querySelectorAll("article").length'), text: await js('document.body.innerText') }
    // Scope replacement controls the snapshot, including failed status.
    await click('保存为新看板')
    await waitFor(`document.querySelector('[role=dialog]') !== null`)
    await js(`[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(e=>e.textContent.trim()==='保存并打开看板')?.click()`)
    await waitFor('window.fbFixture.snapshot !== null')
    const snapshot = await js('window.fbFixture.snapshot')
    await js(`[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(e=>e.textContent.trim()==='取消')?.click()`)
    // Stop prevents later accounts, while retaining the current completed account.
    await js(`window.fbFixture.hold=true; window.fbFixture.fail=''; window.fbFixture.calls=[]`)
    await click('巡检全部已添加账户（3）')
    await waitFor('window.fbFixture.release !== null')
    await click('停止后续读取')
    await js(`window.fbFixture.hold=false; window.fbFixture.release(); window.fbFixture.release=null`)
    await waitFor(`document.body.textContent.includes('已停止，未读取账户单独标记')`)
    const stopped = { calls: await calls(), text: await js('document.body.innerText') }
    // Login failures must stop instead of repeating browser work for every account.
    await js("window.fbFixture.calls=[]; window.fbFixture.fail='123456'; window.fbFixture.failType='login-required'")
    await click('巡检全部已添加账户（3）')
    await waitFor(`document.body.textContent.includes('已停止，未读取账户单独标记') && window.fbFixture.calls.length === 1 && !document.body.textContent.includes(' · Fixture Alpha')`)
    const blocked = await calls()
    await js("window.fbFixture.fail=''")
    // A date change invalidates an in-flight batch and removes old-window cards.
    await js('window.fbFixture.hold=true; window.fbFixture.calls=[]')
    await click('巡检全部已添加账户（3）')
    await waitFor('window.fbFixture.release !== null')
    await click('今天')
    await js('window.fbFixture.hold=false; window.fbFixture.release(); window.fbFixture.release=null')
    await waitFor(`document.querySelectorAll('article').length === 0`)
    const changed = { calls: await calls(), articles: await js('document.querySelectorAll("article").length') }
    await new Promise(resolve => setTimeout(resolve, 200))
    await wc.capturePage().then(img => fs.writeFileSync(path.join(dir,'preview.png'),img.toPNG()))
    console.log('E2E_RESULT ' + JSON.stringify({ initial, single, searchClearedSelection, batch, snapshot, stopped, blocked, changed }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
