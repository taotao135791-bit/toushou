const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.setPath('sessionData', path.join(dir, 'session'))
app.whenReady().then(async () => {
  let win
  let phase = 'startup'
  const deadline = setTimeout(() => { console.log('E2E_RESULT ' + JSON.stringify({ fatal: 'deadline', phase })); process.exitCode = 1; win?.destroy(); app.quit() }, 35000)
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><style>.msg-row{content-visibility:auto;contain-intrinsic-size:auto 600px}</style><div id="root"></div><script src="fixture.js"></script>')
    win = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    // Give Windows a drawable window so real requestAnimationFrame callbacks can run.
    // This isolated synthetic fixture follows the visible-window Windows board tests.
    if (process.platform === 'win32') { win.show(); win.focus() }
    const wc = win.webContents
    wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    await win.loadFile(path.join(dir, 'index.html'))
    const js = async source => {
      let timer
      try {
        return await Promise.race([
          wc.executeJavaScript(source),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('renderer wait deadline in ' + phase)), 5000) })
        ])
      } catch (error) {
        throw new Error('renderer script failed in ' + phase + ': ' + String(error))
      } finally { clearTimeout(timer) }
    }
    const waitFor = async expression => { const end = Date.now() + 5000; while (!await js(expression)) { if (Date.now() > end) throw new Error('timed out in ' + phase); await new Promise(resolve => setTimeout(resolve, 20)) } }
    const frames = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const geometry = () => js(`(() => { const v=document.querySelector('#viewport'); const item=document.querySelector('[data-message-id="synthetic-a-message-5"]'); return {top:v.scrollTop, bottom:v.scrollHeight-v.clientHeight-v.scrollTop, anchor:item ? item.getBoundingClientRect().top-v.getBoundingClientRect().top : null, jump:!!document.querySelector('#jump')} })()`)
    const scrollByUser = top => js(`(() => { const v=document.querySelector('#viewport'); v.dispatchEvent(new WheelEvent('wheel',{deltaY:-80,bubbles:true})); v.scrollTop=${top}; v.dispatchEvent(new Event('scroll')); })()`)

    phase = 'initial session mount'
    await waitFor("document.querySelector('#viewport')?.dataset.session==='synthetic-a'")
    phase = 'initial session animation frames'
    await frames()
    const first = await geometry()
    phase = 'user scroll and content growth'
    await scrollByUser(410)
    await frames()
    const reading = await geometry()
    await js("window.scrollFixture.grow('synthetic-a')")
    await waitFor("document.querySelector('[data-async-preview]').offsetHeight===140")
    await frames(); await frames()
    const readingAfterGrowth = await geometry()

    phase = 'second session initial position'
    await js("window.scrollFixture.switchTo('synthetic-b')")
    await waitFor("document.querySelector('#viewport')?.dataset.session==='synthetic-b'")
    await frames(); await frames()
    const second = await geometry()
    phase = 'async preview while pinned'
    await js("window.scrollFixture.grow('synthetic-b')")
    await waitFor("document.querySelector('[data-async-preview]').offsetHeight===140")
    await frames(); await frames()
    const pinnedAfterGrowth = await geometry()

    phase = 'restore original session'
    await js("window.scrollFixture.switchTo('synthetic-a')")
    phase = 'restore original session mount'
    await waitFor("document.querySelector('#viewport')?.dataset.session==='synthetic-a'")
    phase = 'restore original session frames'
    await frames(); await frames()
    const restored = await geometry()
    phase = 'jump then immediate user scroll'
    await waitFor("!!document.querySelector('#jump')")
    await js(`(() => { const v=document.querySelector('#viewport'); document.querySelector('#jump').click(); v.dispatchEvent(new WheelEvent('wheel',{deltaY:-80,bubbles:true})); v.scrollTop=410; v.dispatchEvent(new Event('scroll')); })()`)
    await frames(); await frames()
    const afterImmediateScroll = await geometry()
    phase = 'long history switch'
    await js("window.scrollFixture.switchTo('synthetic-long')")
    phase = 'long history empty render'
    await waitFor("document.querySelector('#viewport')?.dataset.session==='synthetic-long' && document.querySelectorAll('.msg-row').length===0")
    phase = 'long history empty frames'
    await frames()
    phase = 'long history hydrate'
    await js('window.scrollFixture.hydrateLong()')
    phase = 'long history rows render'
    await waitFor("document.querySelectorAll('.msg-row').length===72")
    phase = 'long history hydrated frames'
    await frames(); await frames(); await frames()
    phase = 'long history initial geometry'
    const longInitial = await geometry()
    const scrollUp = () => js(`(() => {const v=document.querySelector('#viewport');v.dispatchEvent(new WheelEvent('wheel',{deltaY:-700,bubbles:true}));v.scrollTop=Math.max(0,v.scrollTop-700);v.dispatchEvent(new Event('scroll'))})()`)
    phase = 'long history first user scroll'
    await js(`(() => {const v=document.querySelector('#viewport');v.dispatchEvent(new WheelEvent('wheel',{deltaY:-700,bubbles:true}));v.scrollTop=Math.floor((v.scrollHeight-v.clientHeight)/2);v.dispatchEvent(new Event('scroll'))})()`)
    phase = 'long history first scroll frames'
    await frames(); await frames()
    phase = 'long history first visible row'
    const longFirst = await geometry()
    const firstVisible = await js(`(() => {const v=document.querySelector('#viewport'),r=v.getBoundingClientRect();const el=document.elementsFromPoint(r.left+r.width/2,r.top+12).find(e=>v.contains(e))?.closest('[data-message-id]');return el?.dataset.messageId??null})()`)

    phase = 'long history second user scroll'
    await scrollUp()
    phase = 'long history second scroll frames'
    await frames(); await frames(); await frames()
    phase = 'long history second visible row'
    const longSecond = await geometry()
    const visible = await js(`(() => {const v=document.querySelector('#viewport'),r=v.getBoundingClientRect();const el=document.elementsFromPoint(r.left+r.width/2,r.top+12).find(e=>v.contains(e))?.closest('[data-message-id]');return el?{id:el.dataset.messageId,offset:el.getBoundingClientRect().top-r.top}:null})()`)
    phase = 'long history leave session'
    await js("window.scrollFixture.switchTo('synthetic-b')")
    await waitFor("document.querySelector('#viewport')?.dataset.session==='synthetic-b'")
    await frames(); await frames()
    phase = 'long history restore session'
    await js("window.scrollFixture.switchTo('synthetic-long')")
    await waitFor("document.querySelector('#viewport')?.dataset.session==='synthetic-long' && document.querySelectorAll('.msg-row').length===72")
    phase = 'long history restore frames'
    await frames(); await frames(); await frames()
    phase = 'long history restored geometry'
    const longRestored = await geometry()
    const restoredAnchor = visible && await js(`(() => {const v=document.querySelector('#viewport'),el=[...v.querySelectorAll('[data-message-id]')].find(e=>e.dataset.messageId===${JSON.stringify(visible.id)});return el?el.getBoundingClientRect().top-v.getBoundingClientRect().top:null})()`)
    console.log('E2E_RESULT ' + JSON.stringify({ first, reading, readingAfterGrowth, second, pinnedAfterGrowth, restored, afterImmediateScroll, longInitial, longFirst, firstVisible, longSecond, visible, longRestored, restoredAnchor }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), phase })); process.exitCode = 1 }
  finally { clearTimeout(deadline); win?.destroy(); app.quit() }
})
