const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.setPath('sessionData', path.join(dir, 'session'))
app.whenReady().then(async () => {
  let win
  try {
    const html = path.join(dir, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body style="margin:0;height:700px"><div id="root" style="height:100%"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: false, width: 1024, height: 700, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    await win.loadFile(html)
    const js = source => wc.executeJavaScript(source)
    const frame = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await new Promise(resolve => setTimeout(resolve, 300))
    await frame()
    await js('window.chatPerfFixture.reset()')
    await js('window.chatPerfFixture.updateBackground()')
    await frame()
    const background = await js(`({commits:window.chatPerfFixture.commits,renderMs:window.chatPerfFixture.renderMs,header:document.querySelector('header').textContent})`)
    await js('window.chatPerfFixture.renameCurrent()'); await frame()
    const renamed = await js(`({commits:window.chatPerfFixture.commits,title:document.querySelector('header').textContent.includes('Renamed current conversation')})`)
    await js('window.chatPerfFixture.updateCurrentStatus()'); await frame()
    const status = await js('window.chatPerfFixture.commits')
    await js('window.chatPerfFixture.updatePermission()'); await frame()
    const permission = await js(`document.querySelector('[aria-label="Permissions"]').disabled`)
    await js('window.chatPerfFixture.addMessage();window.chatPerfFixture.showError()'); await frame()
    const content = await js(`({message:document.body.textContent.includes('Synthetic current message'),error:document.querySelector('header').textContent.includes("Couldn't send")})`)
    console.log('E2E_RESULT ' + JSON.stringify({ background, renamed, status, permission, content }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error) })); process.exitCode = 1 }
  finally { win?.destroy(); app.quit() }
})
