const { app, BrowserWindow, Menu, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.setPath('sessionData', path.join(dir, 'session'))
app.whenReady().then(async () => {
  let win
  let phase = 'initial'
  const dimensions = async () => {
    if (!win || win.isDestroyed()) return { unavailable: true }
    const native = { content: win.getContentBounds(), outer: win.getBounds(), workArea: screen.getDisplayMatching(win.getBounds()).workArea, visible: win.isVisible(), focused: win.isFocused() }
    let renderer
    try { renderer = await win.webContents.executeJavaScript(`({innerWidth,innerHeight,outerWidth,outerHeight,visibility:document.visibilityState,focused:document.hasFocus()})`) }
    catch { renderer = { unavailable: true } }
    return { native, renderer }
  }
  const deadline = setTimeout(() => { console.log('E2E_RESULT ' + JSON.stringify({ fatal: 'Harness deadline before completion', phase })); process.exitCode = 1; win?.destroy(); app.quit() }, 40000)
  try {
    Menu.setApplicationMenu(null)
    const html = path.join(dir, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body style="margin:0;height:700px"><div id="root" style="height:100%"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: false, enableLargerThanScreen: true, width: 1024, height: 700, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    const readyToShow = new Promise(resolve => win.once('ready-to-show', resolve))
    await win.loadFile(html)
    win.show()
    // CI displays can have a smaller work area; preserve the viewport under test.
    win.setContentSize(1024, 700)
    win.focus()
    wc.focus()
    await Promise.race([readyToShow, new Promise((_, reject) => setTimeout(() => reject(new Error('ready-to-show timeout')), 5000))])
    const js = source => wc.executeJavaScript(source)
    const waitFor = async expression => { const until=Date.now()+5000; while(!await js(expression)) { if(Date.now()>until) throw new Error(`${phase}: visible/focused renderer not ready`); await new Promise(resolve=>setTimeout(resolve,15)) } }
    const frame = () => js(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('animation-frame timeout; visible='+document.visibilityState+' focused='+document.hasFocus())),3000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}))})`)
    await waitFor(`document.visibilityState==='visible' && document.hasFocus() && !!window.chatPerfFixture && innerWidth===1024 && innerHeight===700`)
    await frame()
    phase = 'background metadata frames'
    await js('window.chatPerfFixture.reset()')
    await js(`Promise.race([window.chatPerfFixture.updateBackground(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('background frame sequence timeout; visible='+document.visibilityState+' focused='+document.hasFocus())),15000))])`)
    await frame()
    const background = await js(`({commits:window.chatPerfFixture.commits,renderMs:window.chatPerfFixture.renderMs,updates:window.chatPerfFixture.backgroundUpdates,visible:document.visibilityState,header:document.querySelector('header').textContent})`)
    phase = 'current conversation updates'
    await js('window.chatPerfFixture.renameCurrent()'); await frame()
    const renamed = await js(`({commits:window.chatPerfFixture.commits,title:document.querySelector('header').textContent.includes('Renamed current conversation')})`)
    await js('window.chatPerfFixture.updateCurrentStatus()'); await frame()
    const status = await js('window.chatPerfFixture.commits')
    await js('window.chatPerfFixture.updatePermission()'); await frame()
    const permission = await js(`document.querySelector('[aria-label="Permissions"]').disabled`)
    await js('window.chatPerfFixture.addMessage();window.chatPerfFixture.showError()'); await frame()
    const content = await js(`({message:document.body.textContent.includes('Synthetic current message'),error:document.querySelector('header').textContent.includes("Couldn't send")})`)
    phase = 'default save folder recovery on home'
    await js('window.chatPerfFixture.showUnavailableDefault()')
    await waitFor(`!!document.querySelector('.home-hero [data-project-recovery="default"] button')`)
    const defaultRecovery = await js(`(() => {const hero=document.querySelector('.home-hero');return {message:hero.textContent.includes('Confirm the default save folder before starting a conversation without a project.'),path:hero.textContent.includes('/synthetic/default-save-folder'),button:hero.querySelector('[data-project-recovery="default"] button').textContent.trim()}})()`)
    await js(`(() => {const field=document.querySelector('.home-hero textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Unsent default folder brief');field.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await frame()
    await js(`(() => {const button=document.querySelector('.home-hero [data-project-recovery="default"] button');button.click();button.click()})()`)
    await waitFor(`window.chatPerfFixture.recoverySnapshot().workspace==='/synthetic/default-save-folder' && !document.querySelector('.home-hero [data-project-recovery="default"]')`)
    await frame()
    const defaultRecovered = await js(`({ ...window.chatPerfFixture.recoverySnapshot(),promptGone:!document.querySelector('.home-hero').textContent.includes('Confirm the default save folder'),draft:document.querySelector('.home-hero textarea').value })`)
    console.log('E2E_RESULT ' + JSON.stringify({ background, renamed, status, permission, content, defaultRecovery, defaultRecovered }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), phase, dimensions: await dimensions() })); process.exitCode = 1 }
  finally { clearTimeout(deadline); win?.destroy(); app.quit() }
})
