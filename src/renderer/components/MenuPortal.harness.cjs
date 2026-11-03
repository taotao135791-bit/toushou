const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.setPath('sessionData', path.join(dir, 'session'))
app.whenReady().then(async () => {
  let win
  let phase = 'initial'
  try {
    const html = path.join(dir, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: false, width: 1024, height: 700, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    await win.loadFile(html)
    const js = async source => { try { return await wc.executeJavaScript(source) } catch (error) { throw new Error(`${phase}: ${String(error)}`) } }
    const waitFor = async expression => {
      const until = Date.now() + 5000
      while (!await js(expression)) { if (Date.now() > until) throw new Error(`${phase}: timed out: ${expression}`); await new Promise(resolve => setTimeout(resolve, 15)) }
    }
    const frame = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const rect = () => js(`(() => {const e=document.querySelector('#synthetic-menu').parentElement;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}})()`)
    const open = async () => { await js(`document.querySelector('#menu-trigger').click()`); await waitFor(`!!document.querySelector('#synthetic-menu') && getComputedStyle(document.querySelector('#synthetic-menu').parentElement).visibility==='visible'`); await frame() }
    const close = async () => { await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`); await waitFor(`!document.querySelector('#synthetic-menu')`) }
    const mouse = async (selector, type) => {
      const point = await js(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      wc.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 })
    }
    await waitFor('!!window.menuFixture')
    await open()
    const initial = await rect()
    await js(`(() => {const e=document.querySelector('#menu-draft');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'中文草稿保持原样');e.dispatchEvent(new Event('input',{bubbles:true}));window.styleMutations=[];window.styleObserver=new MutationObserver(rows=>window.styleMutations.push(...rows.map(row=>({old:row.oldValue,current:row.target.getAttribute('style')}))));window.styleObserver.observe(document.querySelector('#synthetic-menu').parentElement,{attributes:true,attributeFilter:['style'],attributeOldValue:true})})()`)
    phase = 'stream updates'
    for (let n = 1; n <= 30; n++) {
      await js('window.menuFixture.rerender()')
      await waitFor(`window.menuFixture.snapshot().stream===${n}`)
      await js(`window.dispatchEvent(new Event('focus'))`)
      await frame()
    }
    const streaming = await js(`({mutations:window.styleMutations,focused:document.activeElement.id,draft:document.querySelector('#menu-draft').value,state:window.menuFixture.snapshot()})`)
    streaming.bounds = await rect()
    await js('window.styleObserver.disconnect()')
    phase = 'resize content'
    await js('window.menuFixture.rows(40)')
    await waitFor(`document.querySelector('#synthetic-menu').parentElement.scrollHeight>document.querySelector('#synthetic-menu').parentElement.clientHeight`)
    await frame()
    const expanded = await rect()
    const expandedFocus = await js(`document.activeElement.id==='menu-draft' && document.querySelector('#menu-draft').value==='中文草稿保持原样'`)
    win.setContentSize(800, 540)
    await waitFor('innerWidth===800 && innerHeight===540')
    await frame()
    const resized = await rect()
    await js('window.menuFixture.rows(1);window.menuFixture.move(12,12)')
    await frame()
    const moved = await rect()
    phase = 'IME and normal Escape'
    const ime = await js(`(() => {const e=document.querySelector('#menu-draft');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));return {open:window.menuFixture.snapshot().open,focus:document.activeElement.id,draft:e.value}})()`)
    await frame()
    ime.open = await js('window.menuFixture.snapshot().open')
    await close()
    const escaped = await js(`({focus:document.activeElement.id,closedWith:window.menuFixture.snapshot().closedWith})`)
    phase = 'repeated opens and clicks'
    await js('window.menuFixture.move(650,460);window.menuFixture.rows(3)')
    win.setContentSize(1024, 700)
    await waitFor('innerWidth===1024 && innerHeight===700')
    for (let n = 1; n <= 8; n++) {
      await open()
      await mouse('#menu-action', 'mouseDown')
      await js('window.menuFixture.rerender()')
      await frame()
      await mouse('#menu-action', 'mouseUp')
      await waitFor(`window.menuFixture.snapshot().clicks===${n} && !window.menuFixture.snapshot().open`)
    }
    const repeated = await js('window.menuFixture.snapshot()')
    phase = 'outside pointer'
    await open()
    await mouse('#outside', 'mouseDown')
    await mouse('#outside', 'mouseUp')
    await waitFor('!window.menuFixture.snapshot().open')
    const outsideClosed = await js('!window.menuFixture.snapshot().open')
    console.log('E2E_RESULT ' + JSON.stringify({ initial, streaming, expanded, expandedFocus, resized, moved, ime, escaped, repeated, outsideClosed }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), phase })); process.exitCode = 1 }
  finally { win?.destroy(); app.quit() }
})
