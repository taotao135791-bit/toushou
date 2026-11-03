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
  const deadline = setTimeout(() => { console.log('E2E_RESULT ' + JSON.stringify({ fatal: 'Harness deadline before completion', phase })); process.exitCode = 1; win?.destroy(); app.quit() }, 30000)
  try {
    Menu.setApplicationMenu(null)
    const html = path.join(dir, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>')
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
    const js = async source => { try { return await wc.executeJavaScript(source) } catch (error) { throw new Error(`${phase}: ${String(error)}`) } }
    const waitFor = async expression => {
      const until = Date.now() + 5000
      while (!await js(expression)) { if (Date.now() > until) throw new Error(`${phase}: timed out: ${expression}`); await new Promise(resolve => setTimeout(resolve, 15)) }
    }
    // A hidden/occluded Windows renderer may not produce animation frames.
    // Fail with the phase instead of hanging until the parent kills Electron.
    const frame = () => js(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('animation-frame timeout; visible='+document.visibilityState+' focused='+document.hasFocus())),3000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}))})`)
    const focusWindow = async () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); wc.focus(); await waitFor(`document.visibilityState==='visible' && document.hasFocus()`); await frame() }
    const rect = () => js(`(() => {const e=document.querySelector('#synthetic-menu').parentElement;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}})()`)
    const settledRect = async () => {
      const until = Date.now() + 5000
      let previous
      let current
      while (Date.now() < until) {
        await frame()
        current = await rect()
        const withinViewport = current.width > 0 && current.height > 0 && current.left >= 8 && current.top >= 8 && current.right <= current.viewportWidth - 8 && current.bottom <= current.viewportHeight - 8
        if (withinViewport && JSON.stringify(current) === JSON.stringify(previous)) return current
        previous = current
      }
      throw new Error(`${phase}: menu geometry did not settle inside the original 8px margins: ${JSON.stringify(current)}`)
    }
    const open = async () => { await focusWindow(); await js(`document.querySelector('#menu-trigger').click()`); await waitFor(`!!document.querySelector('#synthetic-menu') && getComputedStyle(document.querySelector('#synthetic-menu').parentElement).visibility==='visible'`); await settledRect() }
    const close = async () => { await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`); await waitFor(`!document.querySelector('#synthetic-menu')`) }
    const mouse = async (selector, type) => {
      await focusWindow()
      const point = await js(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      wc.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 })
    }
    await focusWindow()
    await waitFor(`!!window.menuFixture && innerWidth===1024 && innerHeight===700`)
    await open()
    const initial = await settledRect()
    await js(`(() => {const e=document.querySelector('#menu-draft');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'中文草稿保持原样');e.dispatchEvent(new Event('input',{bubbles:true}));window.styleMutations=[];window.styleObserver=new MutationObserver(rows=>window.styleMutations.push(...rows.map(row=>({old:row.oldValue,current:row.target.getAttribute('style')}))));window.styleObserver.observe(document.querySelector('#synthetic-menu').parentElement,{attributes:true,attributeFilter:['style'],attributeOldValue:true})})()`)
    phase = 'stream updates'
    for (let n = 1; n <= 30; n++) {
      await js('window.menuFixture.rerender()')
      await waitFor(`window.menuFixture.snapshot().stream===${n}`)
      await js(`window.dispatchEvent(new Event('focus'))`)
      await frame()
    }
    const streaming = await js(`({mutations:window.styleMutations,focused:document.activeElement.id,draft:document.querySelector('#menu-draft').value,state:window.menuFixture.snapshot()})`)
    streaming.bounds = await settledRect()
    await js('window.styleObserver.disconnect()')
    phase = 'resize content'
    await js('window.menuFixture.rows(40)')
    await waitFor(`document.querySelector('#synthetic-menu').parentElement.scrollHeight>document.querySelector('#synthetic-menu').parentElement.clientHeight`)
    await frame()
    const expanded = await settledRect()
    const expandedFocus = await js(`document.activeElement.id==='menu-draft' && document.querySelector('#menu-draft').value==='中文草稿保持原样'`)
    win.setContentSize(800, 540)
    await waitFor('innerWidth===800 && innerHeight===540')
    await frame()
    const resized = await settledRect()
    await js('window.menuFixture.rows(1);window.menuFixture.move(12,12)')
    await frame()
    const moved = await settledRect()
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
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), phase, dimensions: await dimensions() })); process.exitCode = 1 }
  finally { clearTimeout(deadline); win?.destroy(); app.quit() }
})
