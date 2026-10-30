const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
const preload = path.join(dir, 'preload.cjs')
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{browserShow:(bounds,url)=>ipcRenderer.invoke('fixture-show',bounds,url),browserHide:()=>ipcRenderer.invoke('fixture-hide'),browserSetBounds:bounds=>ipcRenderer.invoke('fixture-bounds',bounds),onBrowserState:()=>()=>{},browserNavigate:async()=>({ok:true}),openExternalUrl:async()=>({ok:true})});`)
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ show: false, width: 1024, height: 768, useContentSize: true, webPreferences: { preload, sandbox: true, contextIsolation: true } })
    const panel = new WebContentsView({ webPreferences: { sandbox: true } })
    await panel.webContents.loadURL('data:text/html,<body style="background:blue">fixture</body>')
    const calls = []
    ipcMain.handle('fixture-show', (_e, bounds, url) => { calls.push({ kind: 'show', url: url ?? null }); win.contentView.addChildView(panel); panel.setBounds(bounds); return {ok:true} })
    ipcMain.handle('fixture-hide', () => { calls.push({kind:'hide'}); panel.setBounds({x:2000,y:0,width:560,height:700}); return {ok:true} })
    ipcMain.handle('fixture-bounds', (_e, bounds) => { panel.setBounds(bounds); return {ok:true} })
    const html = path.join(dir, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    const wc = win.webContents
    wc.on('console-message', (_event, _level, message) => console.log('RENDERER '+message))
    await win.loadFile(html)
    const wait = () => new Promise(r => setTimeout(r, 200))
    await wait()
    await wc.executeJavaScript("document.querySelector('#opener').focus(); document.querySelector('#opener').click()")
    await wait()
    const hidden = panel.getBounds().x === 2000
    const focusInside = await wc.executeJavaScript("document.querySelector('[role=alertdialog]').contains(document.activeElement)")
    const tabTrap = await wc.executeJavaScript(`(() => {const d=document.querySelector('[role=alertdialog]');const b=d.querySelectorAll('button');b[b.length-1].focus();const e=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return e.defaultPrevented&&document.activeElement===b[0]})()`)
    // Open a nested boundary by calling the fixture control programmatically.
    await wc.executeJavaScript("document.querySelector('#nested-opener').click()")
    await wait()
    const nestedHidden = panel.getBounds().x === 2000
    await wc.executeJavaScript("document.querySelector('#nested-close').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
    await wait()
    const staysHidden = panel.getBounds().x === 2000
    const parentStillOpen = await wc.executeJavaScript("Boolean(document.querySelector('[role=alertdialog]')) && !document.querySelector('#nested')")
    await wc.executeJavaScript("document.querySelector('[role=alertdialog] button').click()")
    await wait()
    const restored = panel.getBounds().x !== 2000
    const focusRestored = await wc.executeJavaScript("document.activeElement?.id === 'opener'")
    console.log('E2E_RESULT '+JSON.stringify({hidden,focusInside,tabTrap,nestedHidden,staysHidden,parentStillOpen,restored,focusRestored,calls}))
  } catch (error) { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)})) }
  finally { if(win&&!win.isDestroyed())win.destroy(); app.exit(0) }
}).catch(error => {console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)}));app.exit(1)})
