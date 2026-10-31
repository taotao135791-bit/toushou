const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
const preload = path.join(dir, 'preload.cjs')
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{browserShow:(bounds,url)=>ipcRenderer.invoke('fixture-show',bounds,url),browserHide:()=>ipcRenderer.invoke('fixture-hide'),browserSetBounds:bounds=>ipcRenderer.invoke('fixture-bounds',bounds),onBrowserState:()=>()=>{},browserNavigate:async()=>({ok:true}),openExternalUrl:async()=>({ok:true}),fxRatesGet:async()=>null,adsCopyModelsList:async()=>({mode:'chat',providers:[],storeUnavailable:true}),ttReadingSummary:async({advertiserIds})=>({range:'1',startDate:'2026-10-30',endDate:'2026-10-31',totals:{spend:200,impressions:100,clicks:10,ctr:.1,conversions:2,costPerConversion:100},source:'oauth',generatedAt:1,advertisers:[{advertiserId:'1111111',name:'A',currency:'USD'},{advertiserId:'2222222',name:'B',currency:'EUR'}],failed:[],currency:advertiserIds==='mixed'?null:'USD',mixedCurrency:advertiserIds==='mixed',datasetSync:advertiserIds==='mixed'?{ok:false,error:'write-failed'}:{ok:true,legacyBackups:['TikTok 报表（旧数据备份）']},accountWindows:[{advertiserId:'1111111',timezone:'UTC',startDate:'2026-10-31',endDate:'2026-10-31'},{advertiserId:'2222222',timezone:'America/Los_Angeles',startDate:'2026-10-30',endDate:'2026-10-30'}],topCampaigns:[{name:'EXPENSE_TOP_SHOULD_HIDE',spend:100,impressions:100,clicks:10,conversions:2}]})});`)
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
    const sourceCss = fs.readFileSync(path.resolve(process.cwd(),'src/renderer/index.css'),'utf8')
    const pageCss = sourceCss.match(/\.page-enter\s*\{[^}]*\}/)?.[0]
    const animCss = sourceCss.match(/@keyframes page-enter\s*\{[\s\S]*?\n\}/)?.[0]
    if (!pageCss || !animCss) throw Error('page animation CSS missing')
    // Force a classic scrollbar, including on macOS where scrollbars are often
    // overlaid. innerWidth includes that scrollbar; fixed inset-0 does not.
    const clippedFixture = process.env.MODAL_FIXTURE_CLIP === '1' ? '.page-enter{transform:translateY(1px)}' : ''
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${pageCss}${animCss}${clippedFixture}html{overflow-y:scroll}::-webkit-scrollbar{width:15px}.fixed{position:fixed}.inset-0{inset:0}.flex{display:flex}.items-center{align-items:center}.justify-center{justify-content:center}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    const wc = win.webContents
    wc.on('console-message', (_event, _level, message) => console.log('RENDERER '+message))
    await win.loadFile(html)
    const wait = () => new Promise(r => setTimeout(r, 200))
    await wait()
    const tt = await wc.executeJavaScript("({mixed:document.querySelector('#tt-mixed').textContent, backup:document.querySelector('#tt-backup').textContent, modelsAlert:document.querySelector('#models [role=alert]')?.textContent, models:document.querySelector('#models').textContent})")
    const metrics = await wc.executeJavaScript("({unknown:document.querySelector('#money-unknown').textContent,chart:document.querySelector('#money-chart').querySelector('[role=status]')?.textContent,ctr:document.querySelector('#weighted-ctr').textContent})")
    await wc.executeJavaScript("document.querySelector('#opener').focus(); document.querySelector('#opener').click()")
    await wait()
    const hidden = panel.getBounds().x === 2000
    const backdrop = await wc.executeJavaScript("(() => { const el=document.querySelector('[role=alertdialog]').parentElement; const r=el.getBoundingClientRect(); const root=document.documentElement; return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:root.clientWidth,viewportHeight:root.clientHeight,innerWidth,innerHeight,devicePixelRatio,visualViewportScale:visualViewport.scale,cornerCovered:[[1,1],[root.clientWidth-1,1],[1,root.clientHeight-1],[root.clientWidth-1,root.clientHeight-1]].every(([x,y])=>el.contains(document.elementFromPoint(x,y)))} })()")
    const fullViewport = backdrop.left <= 0 && backdrop.top <= 0 && backdrop.right >= backdrop.viewportWidth && backdrop.bottom >= backdrop.viewportHeight && backdrop.cornerCovered
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
    console.log('E2E_RESULT '+JSON.stringify({tt,metrics,hidden,fullViewport,backdrop,focusInside,tabTrap,nestedHidden,staysHidden,parentStillOpen,restored,focusRestored,calls}))
  } catch (error) { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)})) }
  finally { if(win&&!win.isDestroyed())win.destroy(); app.exit(0) }
}).catch(error => {console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)}));app.exit(1)})
