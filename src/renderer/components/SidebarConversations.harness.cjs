const { app, BrowserWindow, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  let phase = 'startup'
  try {
    Menu.setApplicationMenu(null)
    const html = path.join(dir, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: false, useContentSize: true, width: 1024, height: 700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    const readyToShow = new Promise(resolve => win.once('ready-to-show', resolve))
    const bounded = (promise, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${phase}: timed out ${label}`)), 8000)
      promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
    wc.on('console-message', (_event, _level, message) => console.log('RENDERER ' + message))
    wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    await win.loadFile(html)
    await bounded(readyToShow, 'ready-to-show')
    win.show()
    app.focus({ steal: true })
    win.focus()
    wc.focus()
    const js = async source => { try { return await wc.executeJavaScript(source) } catch (error) { throw new Error(`${phase}: ${source}: ${String(error)}`) } }
    const waitFor = async expression => { const until = Date.now() + 8000; while (!await js(expression)) { if (Date.now() > until) throw new Error(`${phase}: timed out ${expression}`); await new Promise(resolve => setTimeout(resolve, 20)) } }
    const row = (scope, n) => `([...document.querySelectorAll('${scope} [data-conversation-key]')].find(e=>JSON.parse(e.dataset.conversationKey)[1]===window.sidebarFixture.uuid(${n})))`
    const frame = () => bounded(js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'), 'two animation frames')
    const foreground = async () => {
      if (!win.isFocused() || !await js('document.hasFocus()')) {
        app.focus({ steal: true })
        win.focus()
        wc.focus()
      }
      await waitFor(`document.visibilityState==='visible' && document.hasFocus()`)
    }
    const focusElement = async element => {
      await foreground()
      await js(`${element}.scrollIntoView({block:'nearest'});${element}.focus()`)
      await waitFor(`document.activeElement===${element}`)
      await frame()
    }
    const settleMenu = async () => {
      await waitFor(`(() => {const e=document.querySelector('[data-session-action-menu]');if(!e)return false;const r=e.getBoundingClientRect();return getComputedStyle(e).visibility!=='hidden'&&r.width>0&&r.height>0})()`)
      await frame()
    }
    const mouseSelect = async (scope, n) => {
      const element = `${row(scope, n)}.querySelector('[data-conversation-select]')`
      await foreground()
      await js(`${element}.scrollIntoView({block:'nearest'})`)
      await frame()
      const point = await js(`(() => {const r=${element}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      const hit = await js(`(() => {const e=${element},p=document.elementFromPoint(${point.x},${point.y});return {inside:!!p&&e.contains(p),point:${JSON.stringify(point)},button:e.getBoundingClientRect().toJSON(),list:document.querySelector('[data-all-conversations]').getBoundingClientRect().toJSON(),hit:p?.outerHTML.slice(0,220)}})()`)
      if (!hit.inside) throw new Error(`primary button is clipped: ${JSON.stringify(hit)}`)
      wc.sendInputEvent({ type: 'mouseMove', ...point })
      wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
      await frame()
    }
    const nativeKeyboardClicks = []
    const enter = async () => {
      await js(`window.nativeEnterClicks=[];window.nativeEnterListener=event=>window.nativeEnterClicks.push({trusted:event.isTrusted,target:event.target.closest('button')?.getAttribute('data-session-action')??event.target.tagName});document.addEventListener('click',window.nativeEnterListener,true)`)
      // Electron's explicit char event supplies Chromium's native keypress;
      // keyDown/keyUp alone do not activate a focused button on macOS.
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      wc.sendInputEvent({ type: 'char', keyCode: '\r' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await frame()
      const clicks = await js(`(() => {document.removeEventListener('click',window.nativeEnterListener,true);return window.nativeEnterClicks})()`)
      nativeKeyboardClicks.push(clicks.length)
      if (clicks.length !== 1 || !clicks[0].trusted) throw new Error(`${phase}: Enter must activate exactly once through native input: ${JSON.stringify(clicks)}`)
    }
    const openActions = async n => {
      await focusElement(`${row('[data-all-conversations]', n)}.querySelector('[data-session-actions]')`)
      await enter()
      await settleMenu()
    }
    await waitFor(`document.visibilityState==='visible' && document.hasFocus() && innerWidth===1024 && innerHeight===700`)
    await waitFor(`document.querySelectorAll('[data-all-conversations] [data-conversation-key]').length===20`)
    const defaultHidden = await js(`!document.querySelector('[data-project-id="default"]') && !${row('[data-all-conversations]', 5)}.textContent.includes('TouShou workspace')`)
    await js(`document.querySelector('[aria-label="Conversations in Alpha"]').click()`)
    await waitFor(`document.querySelectorAll('[data-project-conversations="alpha"] [data-conversation-key]').length===17`)
    const duplicateTitlesKept = await js(`[...document.querySelectorAll('[data-project-conversations="alpha"] [data-conversation-key]')].filter(e=>e.textContent.includes('Duplicate topic')).length`)
    await js(`document.querySelector('[data-project-list]').scrollTop=60;document.querySelector('[data-all-conversations]').scrollTop=80;window.keptConversationNode=${row('[data-all-conversations]', 3)}`)
    const before = await js(`({projectScroll:document.querySelector('[data-project-list]').scrollTop,allScroll:document.querySelector('[data-all-conversations]').scrollTop,expanded:document.querySelector('[aria-label="Conversations in Alpha"]').getAttribute('aria-expanded'),historyReads:window.sidebarFixture.historyCalls.length})`)
    await js(`window.dispatchEvent(new Event('focus'))`)
    await new Promise(resolve => setTimeout(resolve, 80))
    const after = await js(`({projectScroll:document.querySelector('[data-project-list]').scrollTop,allScroll:document.querySelector('[data-all-conversations]').scrollTop,expanded:document.querySelector('[aria-label="Conversations in Alpha"]').getAttribute('aria-expanded'),historyReads:window.sidebarFixture.historyCalls.length,sameNode:window.keptConversationNode===${row('[data-all-conversations]', 3)},animated:[...document.querySelectorAll('[data-conversation-key]')].some(e=>!!e.style.transform)})`)
    phase = 'independent action buttons'
    await openActions(2)
    const actionMenuCount = await js(`document.querySelectorAll('[data-session-action-menu] button').length`)
    await focusElement(`document.querySelector('[data-session-action="pin"]')`)
    await enter()
    await waitFor(`window.sidebarFixture.pinned().includes('live-b')`)
    const pinKeyboard = await js(`({snapshot:window.sidebarFixture.snapshot(),activations:window.sidebarFixture.activateCalls.length,resumes:window.sidebarFixture.resumeCalls.length})`)
    for (const n of [3, 4]) {
      await focusElement(`${row('[data-all-conversations]', n)}.querySelector('[title="Delete session file"]')`)
      await enter()
      await waitFor(`!!document.querySelector('[role="alertdialog"]')`)
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await waitFor(`!document.querySelector('[role="alertdialog"]')`)
    }
    const deleteKeyboard = await js(`({snapshot:window.sidebarFixture.snapshot(),resumes:window.sidebarFixture.resumeCalls.length,deletes:window.sidebarFixture.deleteCalls})`)
    const beforeHover = await js(`(() => {const r=${row('[data-all-conversations]', 2)}.querySelector('[data-conversation-select]').getBoundingClientRect();return {left:r.left,width:r.width}})()`)
    await mouseSelect('[data-all-conversations]', 2)
    await waitFor(`window.sidebarFixture.snapshot().current==='live-b'`)
    const centerMouse = await js(`(() => {const r=${row('[data-all-conversations]', 2)}.querySelector('[data-conversation-select]').getBoundingClientRect();return {snapshot:window.sidebarFixture.snapshot(),pinned:window.sidebarFixture.pinned(),deletes:window.sidebarFixture.deleteCalls,bounds:{left:r.left,width:r.width}}})()`)
    phase = 'project selection'
    await js(`document.querySelector('[aria-label="Conversations in Beta"]').click()`)
    await waitFor(`!!${row('[data-project-conversations="beta"]', 2)}`)
    phase = 'one click across delayed project scans'
    const targetReadsBefore = await js(`window.sidebarFixture.historyCalls.filter(id=>id==='grant-beta').length`)
    await js('window.sidebarFixture.beginDefaultScan()')
    await waitFor(`window.sidebarFixture.pendingHistory.has('grant-default')`)
    await mouseSelect('[data-project-conversations="beta"]', 4)
    await waitFor(`window.sidebarFixture.pendingHistory.has('grant-beta')`)
    await js(`window.sidebarFixture.releaseHistory('grant-beta')`)
    await waitFor(`window.sidebarFixture.snapshot().current==='resumed-'+window.sidebarFixture.uuid(4)`)
    await js(`window.sidebarFixture.releaseHistory('grant-default')`)
    await new Promise(resolve => setTimeout(resolve, 40))
    const oneClickHistory = await js(`({snapshot:window.sidebarFixture.snapshot(),targetReads:window.sidebarFixture.historyCalls.filter(id=>id==='grant-beta').length-${targetReadsBefore},resumes:window.sidebarFixture.resumeCalls.length})`)
    phase = 'project selection'
    await mouseSelect('[data-project-conversations="beta"]', 2)
    await waitFor(`window.sidebarFixture.snapshot().current==='live-b' && window.sidebarFixture.snapshot().workspace==='/synthetic/client-b/project'`)
    const afterProjectSelect = await js(`({snapshot:window.sidebarFixture.snapshot(),expanded:document.querySelector('[aria-label="Conversations in Alpha"]').getAttribute('aria-expanded'),activateCalls:window.sidebarFixture.activateCalls.length})`)
    await js(`document.querySelector('[data-project-id="beta"] button[title="/synthetic/client-b/project"]').click()`)
    await new Promise(resolve => setTimeout(resolve, 40))
    const noExtraActivation = await js(`window.sidebarFixture.activateCalls.length===${afterProjectSelect.activateCalls}`)
    phase = 'late history resume'
    await js('window.sidebarFixture.slowResume=true')
    await mouseSelect('[data-project-conversations="alpha"]', 3)
    await waitFor('!!window.sidebarFixture.finishResume')
    await mouseSelect('[data-project-conversations="alpha"]', 1)
    await waitFor(`window.sidebarFixture.snapshot().current==='live-a'`)
    await js('window.sidebarFixture.finishResume()')
    await new Promise(resolve => setTimeout(resolve, 80))
    const afterLateResume = await js(`({snapshot:window.sidebarFixture.snapshot(),resumes:window.sidebarFixture.resumeCalls,projectCount:document.querySelectorAll('[data-project-conversations="alpha"] [data-conversation-key]').length,allCount:document.querySelectorAll('[data-all-conversations] [data-conversation-key]').length,expanded:document.querySelector('[aria-label="Conversations in Alpha"]').getAttribute('aria-expanded')})`)
    phase = 'archived primary button'
    await js(`window.sidebarFixture.slowResume=false;window.sidebarFixture.archivePastConversation();document.querySelector('[title="Sort sessions"]').click()`)
    await waitFor(`!!document.querySelector('[role="switch"]')`)
    await js(`document.querySelector('[role="switch"]').click();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await js(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Archived (1)').click()`)
    await waitFor(`!!${row('[data-all-conversations]', 10)}`)
    const archivedSemantics = await js(`({outerRole:${row('[data-all-conversations]', 10)}.getAttribute('role'),primaryHasNested:${row('[data-all-conversations]', 10)}.querySelector('[data-conversation-select]').querySelectorAll('button,input,a,select').length})`)
    await mouseSelect('[data-all-conversations]', 10)
    await waitFor(`window.sidebarFixture.snapshot().current==='resumed-'+window.sidebarFixture.uuid(10)`)
    const allRowsSemantic = await js(`[...document.querySelectorAll('[data-conversation-key]')].every(e=>!e.hasAttribute('role')&&!!e.querySelector('[data-conversation-select]')&&!e.querySelector('[data-conversation-select] button'))`)
    phase = 'global New Chat null-to-null intent'
    await js(`window.sidebarFixture.globalNewChat();window.sidebarFixture.slowResume=true`)
    await mouseSelect('[data-project-conversations="alpha"]', 11)
    await waitFor('!!window.sidebarFixture.finishResume')
    await js('window.sidebarFixture.globalNewChat();window.sidebarFixture.finishResume()')
    await new Promise(resolve => setTimeout(resolve, 50))
    const globalNewChat = await js('window.sidebarFixture.snapshot()')
    phase = 'late project activation versus Sidebar New Chat'
    await js('window.sidebarFixture.slowActivation=true;window.sidebarFixture.addBetaHistory()')
    await waitFor(`!!${row('[data-all-conversations]', 30)}`)
    await mouseSelect('[data-all-conversations]', 30)
    await waitFor('!!window.sidebarFixture.finishActivation')
    await js(`document.querySelector('nav button').click();window.sidebarFixture.finishActivation();window.sidebarFixture.slowActivation=false`)
    await new Promise(resolve => setTimeout(resolve, 50))
    const lateActivation = await js('window.sidebarFixture.snapshot()')
    phase = 'queued history versus real Composer project choice'
    await mouseSelect('[data-project-conversations="alpha"]', 12)
    await waitFor('!!window.sidebarFixture.finishResume')
    await mouseSelect('[data-all-conversations]', 30)
    await js(`document.querySelector('[aria-label="Choose project"]').click()`)
    await waitFor(`!!document.querySelector('[aria-label="Choose a project"]')`)
    await js(`[...document.querySelector('[aria-label="Choose a project"]').querySelectorAll('button')].find(e=>e.textContent.trim()==='No project').click()`)
    await waitFor(`window.sidebarFixture.snapshot().workspace==='/synthetic/TouShou workspace'`)
    await js('window.sidebarFixture.finishResume()')
    await new Promise(resolve => setTimeout(resolve, 60))
    const composerWins = await js(`({snapshot:window.sidebarFixture.snapshot(),queuedTargetResumed:window.sidebarFixture.resumeCalls.some(call=>call.historyId.includes(window.sidebarFixture.uuid(30)))})`)
    phase = 'first send and late creation'
    const typePrompt = async text => { await js(`(() => {const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`); await frame() }
    await typePrompt('Synthetic first prompt')
    await js(`document.querySelector('button[aria-label="Send"]').click()`)
    await waitFor('window.sidebarFixture.sent.length===1')
    const firstSend = await js(`({snapshot:window.sidebarFixture.snapshot(),sent:window.sidebarFixture.sent[0]})`)
    await js('window.sidebarFixture.globalNewChat();window.sidebarFixture.slowCreate=true')
    await waitFor(`!!document.querySelector('textarea')`)
    await typePrompt('Synthetic background prompt')
    await js(`document.querySelector('button[aria-label="Send"]').click()`)
    await waitFor('!!window.sidebarFixture.finishCreate')
    await mouseSelect('[data-all-conversations]', 2)
    await waitFor(`window.sidebarFixture.snapshot().current==='live-b'`)
    await js('window.sidebarFixture.finishCreate()')
    await waitFor('window.sidebarFixture.sent.length===2')
    const lateCreate = await js(`({snapshot:window.sidebarFixture.snapshot(),sent:window.sidebarFixture.sent[1]})`)
    phase = 'running archive confirmation in action menu'
    await js(`window.sidebarFixture.markRunning('live-a')`)
    await waitFor(`${row('[data-all-conversations]', 1)}.querySelector('[data-conversation-select]').getAttribute('aria-label').endsWith(', Running')`)
    await openActions(1)
    await focusElement(`document.querySelector('[data-session-action="archive"]')`)
    await enter()
    const firstArchive = await js(`({open:!!document.querySelector('[data-session-action-menu]'),text:document.querySelector('[data-session-action="archive"]').textContent,kills:window.sidebarFixture.killed.length})`)
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await waitFor(`!document.querySelector('[data-session-action-menu]')`)
    await openActions(1)
    const resetArchive = await js(`document.querySelector('[data-session-action="archive"]').textContent`)
    await focusElement(`document.querySelector('[data-session-action="archive"]')`)
    await enter(); await enter()
    await waitFor(`window.sidebarFixture.killed.length===1`)
    const finalArchive = await js(`({open:!!document.querySelector('[data-session-action-menu]'),snapshot:window.sidebarFixture.snapshot(),kills:window.sidebarFixture.killed})`)
    const fullTitle = await js(`${row('[data-all-conversations]', 2)}.querySelector('[data-conversation-select]').title`)
    console.log('E2E_RESULT ' + JSON.stringify({ defaultHidden, duplicateTitlesKept, before, after, actionMenuCount, pinKeyboard, deleteKeyboard, beforeHover, centerMouse, oneClickHistory, afterProjectSelect, noExtraActivation, afterLateResume, archivedSemantics, allRowsSemantic, globalNewChat, lateActivation, composerWins, firstSend, lateCreate, firstArchive, resetArchive, finalArchive, fullTitle, nativeKeyboardClicks }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), phase })); process.exitCode = 1 }
  finally { win?.destroy(); app.quit() }
})
