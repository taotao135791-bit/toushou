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
    const waitFor = async expression => {
      const until = Date.now() + 5000
      while (!await js(expression)) {
        if (Date.now() > until) {
          const state = await js(`(() => {const el=document.activeElement;const trigger=document.querySelector('button[aria-label="Add content"]');const action=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='Attach image');return {active:el?.getAttribute('aria-label')||el?.tagName,expanded:trigger?.getAttribute('aria-expanded'),attachment:action?getComputedStyle(action).visibility:'missing',events:window.composerInputEvents?.slice(-15)}})()`)
          throw new Error(`${phase}: timed out: ${expression}; renderer: ${JSON.stringify(state)}`)
        }
        await new Promise(resolve => setTimeout(resolve, 15))
      }
    }
    const frame = () => js(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('animation-frame timeout; visible='+document.visibilityState+' focused='+document.hasFocus())),3000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}))})`)
    await waitFor(`document.visibilityState==='visible' && document.hasFocus() && !!window.chatPerfFixture && innerWidth===1024 && innerHeight===700`)
    await frame()
    phase = 'DeepSeek session thinking selector'
    const modelTrigger = `document.querySelector('button[title="Model"]')`
    const thinkingTrigger = `document.querySelector('button[title="Thinking"]')`
    const thinkingMenu = `[...document.querySelectorAll('body > div')].find(element => element.firstElementChild?.tagName === 'BUTTON' && element.firstElementChild.textContent.trim() === 'Auto')`
    await waitFor(`${modelTrigger}?.ariaLabel === 'Model: DeepSeek-V4.1-Flash' && ${thinkingTrigger}?.ariaLabel === 'Thinking: Auto'`)
    const showThinkingMenu = async () => {
      await js(`${thinkingTrigger}.click()`)
      await waitFor(`!!(${thinkingMenu})`)
    }
    const thinkingLabels = () => js(`[...(${thinkingMenu}).children].map(button => button.textContent.trim())`)
    const chooseThinking = async label => {
      await js(`[...(${thinkingMenu}).children].find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`)
      await waitFor(`${thinkingTrigger}.ariaLabel === ${JSON.stringify(`Thinking: ${label}`)}`)
    }
    await showThinkingMenu()
    const deepSeekThinking = await thinkingLabels()
    for (const [index, label] of ['Low', 'High', 'Max', 'Off'].entries()) {
      if (index > 0) await showThinkingMenu()
      await chooseThinking(label)
    }
    phase = 'switch model thinking capabilities'
    const chooseModel = async name => {
      await js(`${modelTrigger}.click()`)
      const option = `[...document.querySelectorAll('body > div button')].find(button => button.firstElementChild?.firstElementChild?.textContent === ${JSON.stringify(name)})`
      await waitFor(`!!(${option})`)
      await js(`(${option}).click()`)
      await waitFor(`${modelTrigger}.ariaLabel === ${JSON.stringify(`Model: ${name}`)}`)
      await frame()
    }
    await chooseModel('Synthetic budget model')
    await showThinkingMenu()
    const mediumOnlyThinking = await thinkingLabels()
    await chooseThinking('Medium')
    await chooseModel('Synthetic plain model')
    await showThinkingMenu()
    const plainThinking = await thinkingLabels()
    await js(`${thinkingTrigger}.click()`)
    await frame()
    const thinkingSelections = await js('window.chatPerfFixture.thinkingSelections')
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
    const content = await js(`({message:document.body.textContent.includes('Synthetic current message'),error:document.querySelector('header [role=alert]')?.textContent})`)
    await js('window.chatPerfFixture.showStopError()'); await frame()
    const busyError = await js(`document.querySelector('header [role=alert]')?.textContent`)
    phase = 'restored and active reasoning'
    await js('window.chatPerfFixture.showRestoredThinking()'); await frame()
    const restoredThinking = await js(`({timers:window.chatPerfFixture.thinkingTimerCount(),message:document.body.textContent.includes('Restored response 39')})`)
    await js('window.chatPerfFixture.streamThinking()'); await frame()
    const activeThinking = await js('window.chatPerfFixture.thinkingTimerCount()')
    await js('window.chatPerfFixture.interruptThinking()'); await frame()
    const interruptedThinking = await js('window.chatPerfFixture.thinkingTimerCount()')
    phase = 'live board reasoning holds its height while streaming'
    const streamTurn = 'document.querySelector(\'[data-chat-turn="board-stream-question"]\')'
    const streamProcess = `${streamTurn}?.querySelector('section[aria-label="Turn activity"]')`
    const layout = () => js(`(() => {
      const turn = ${streamTurn};
      const reasoning = turn.querySelector('pre');
      const composer = document.querySelector('.chat-composer').getBoundingClientRect();
      let viewport = turn.parentElement;
      while (getComputedStyle(viewport).overflowY !== 'auto') viewport = viewport.parentElement;
      return {reasoningHeight:reasoning?.offsetHeight ?? 0, scrollHeight:viewport.scrollHeight,
        bottom:viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop, composerTop:composer.top, composerHeight:composer.height};
    })()`)
    await js('window.chatPerfFixture.startBoardStream()')
    await waitFor(`${streamTurn}?.querySelector('pre')?.textContent.includes('Synthetic board reasoning begins')`)
    await frame()
    const shortReasoning = await layout()
    await js('window.chatPerfFixture.growBoardThinking()')
    await waitFor(`${streamTurn}?.querySelector('pre')?.textContent.includes('Synthetic board reasoning line 24')`)
    await frame()
    const longReasoning = await layout()
    phase = 'interleaved board tool and manual reasoning'
    await js('window.chatPerfFixture.startBoardTool()')
    await waitFor(`!!(${streamProcess})`)
    await js(`(${streamProcess}).querySelector('button').click()`)
    await waitFor(`(${streamProcess}).querySelector('button').getAttribute('aria-expanded')==='true'`)
    await js('window.chatPerfFixture.continueBoardThinking()')
    const followUpButton = `[...(${streamProcess}).querySelectorAll('button')].filter(button=>button.textContent.trim().startsWith('Thinking')).at(-1)`
    await waitFor(`(${streamProcess}).querySelectorAll('[data-message-id]').length===3`)
    await js('new Promise(resolve=>setTimeout(resolve,1150))')
    await frame()
    const processAutoOpened = await js(`[...(${streamProcess}).querySelectorAll('pre')].some(pre=>pre.textContent.includes('Synthetic follow-up reasoning'))`)
    const collapsedReasoning = await layout()
    await js(`(${followUpButton}).click()`)
    await waitFor(`[...(${streamProcess}).querySelectorAll('pre')].some(pre=>pre.textContent.includes('Synthetic follow-up reasoning'))`)
    const processManuallyOpened = await js(`(${followUpButton}).getAttribute('aria-expanded')==='true'`)
    phase = 'intermediate punctuation remains in board activity'
    await js('window.chatPerfFixture.showBoardPunctuation()')
    await frame()
    const punctuation = await js(`(() => {
      const turn = ${streamTurn};
      const process = ${streamProcess};
      return {inProcess:[...process.querySelectorAll('p')].some(item=>item.textContent.trim()==='.'),
        separate:[...turn.querySelectorAll(':scope > [data-message-id] p')].some(item=>item.textContent.trim()==='.'),
        boardAction: [...turn.querySelectorAll('button')].some(button=>button.title==='Add to board')};
    })()`)
    const afterPunctuation = await layout()
    await js('window.chatPerfFixture.endBoardStream()')
    await frame()
    phase = 'execution updates with no worker or closed activity'
    const probeActivity = "document.querySelector('#projection-probe-activity')"
    const probeCounters = () => js(`({
      activity: window.chatPerfFixture.activityCommits, messages: window.chatPerfFixture.messageListCommits
    })`)
    const projectionFrames = 10
    await js('window.chatPerfFixture.startProjectionProbe()')
    await frame()
    await js('window.chatPerfFixture.resetProjectionCounters()')
    await js(`window.chatPerfFixture.streamProbeMessages('Main only', ${projectionFrames})`)
    await frame()
    const noAgent = { ...(await probeCounters()), empty: await js(`!${probeActivity}.querySelector('section')`) }
    await js('window.chatPerfFixture.startProbeAgent()')
    await waitFor(`${probeActivity}.querySelector('button')?.getAttribute('aria-expanded')==='false'`)
    await js('window.chatPerfFixture.resetProjectionCounters()')
    await js(`window.chatPerfFixture.streamProbeMessages('Closed pane', ${projectionFrames})`)
    await frame()
    const closedAgent = { ...(await probeCounters()), countVisible: await js(`${probeActivity}.textContent.includes('1 agents')`) }
    phase = 'open execution activity and elapsed turn remain live'
    await js(`${probeActivity}.querySelector('button').click()`)
    await waitFor(`${probeActivity}.textContent.includes('Closed pane ${projectionFrames - 1}')`)
    await js('window.chatPerfFixture.resetProjectionCounters()')
    await js("window.chatPerfFixture.streamProbeMessages('Open pane', 1)")
    await waitFor(`${probeActivity}.textContent.includes('Open pane 0')`)
    const openAgent = { ...(await probeCounters()), workerVisible: await js(`${probeActivity}.textContent.includes('Probe worker')`) }
    await js('window.chatPerfFixture.endProjectionProbe()')
    await waitFor("document.querySelector('#projection-probe-messages').textContent.includes('2.5s')")
    const completedElapsed = true
    phase = 'default save folder recovery on home'
    await js('window.chatPerfFixture.showUnavailableDefault()')
    await waitFor(`!!document.querySelector('.home-hero [data-project-recovery="default"] button')`)
    const defaultRecovery = await js(`(() => {const hero=document.querySelector('.home-hero');return {message:hero.textContent.includes('Confirm the default save folder before starting a conversation without a project.'),path:hero.textContent.includes('/synthetic/default-save-folder'),button:hero.querySelector('[data-project-recovery="default"] button').textContent.trim(),destination:hero.querySelector('.composer-tray > button').textContent.trim()}})()`)
    await js(`(() => {const field=document.querySelector('.home-hero textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Unsent default folder brief');field.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await frame()
    await js(`(() => {const button=document.querySelector('.home-hero [data-project-recovery="default"] button');button.click();button.click()})()`)
    await waitFor(`window.chatPerfFixture.recoverySnapshot().workspace==='/synthetic/default-save-folder' && !document.querySelector('.home-hero [data-project-recovery="default"]')`)
    await frame()
    const defaultRecovered = await js(`({ ...window.chatPerfFixture.recoverySnapshot(),promptGone:!document.querySelector('.home-hero').textContent.includes('Confirm the default save folder'),draft:document.querySelector('.home-hero textarea').value })`)
    phase = 'native undo after typing in the composer'
    win.focus()
    wc.focus()
    await waitFor('document.hasFocus()')
    const field = `document.querySelector('.chat-composer textarea')`
    const addTrigger = `document.querySelector('button[aria-label="Add content"]')`
    const invokeAction = `[...document.querySelectorAll('button')].find(button => button.textContent.trim()==='Use skill / plugin…')`
    const search = `document.querySelector('input[role="combobox"][aria-label="Filter skills, commands and plugins"]')`
    const skillOption = `[...document.querySelectorAll('button[role="option"]')].find(button => button.textContent.trim()==='Synthetic team skill')`
    await js(`window.composerInputEvents=[];for(const type of ['focusin','pointerdown','click','keyup'])document.addEventListener(type,event=>{
      const el=event.target;const label=el.getAttribute?.('aria-label')||(el.tagName==='BUTTON'?el.textContent.trim():el.tagName);
      window.composerInputEvents.push({type,label,key:event.key,trusted:event.isTrusted});
    },true)`)
    const key = (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    const undo = async () => {
      const before = await js('window.composerInputEvents.length')
      key('Z', [process.platform === 'darwin' ? 'meta' : 'control'])
      await waitFor(`window.composerInputEvents.slice(${before}).some(({type,key,trusted})=>type==='keyup'&&key?.toLowerCase()==='z'&&trusted)`)
      await frame()
    }
    const click = async (expression) => {
      await waitFor(`!!(${expression}) && getComputedStyle((${expression})).visibility==='visible'`)
      const point = await js(`(() => {const r=(${expression}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      wc.sendInputEvent({ type: 'mouseMove', ...point })
      wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    }
    const openPicker = async () => {
      await click(addTrigger)
      await waitFor(`${addTrigger}.getAttribute('aria-expanded')==='true'`)
      await click(invokeAction)
      await waitFor(`!!${search}`)
      await waitFor(`getComputedStyle(${search}).visibility==='visible'`)
      await waitFor(`${search}===document.activeElement`)
      await waitFor(`!!(${skillOption})`)
    }
    await js('window.chatPerfFixture.prepareComposer()')
    await waitFor(`${field}?.value==='Review'`)
    await frame()
    await js(`${field}.focus(); ${field}.setSelectionRange(6,6)`)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'X' })
    wc.sendInputEvent({ type: 'char', keyCode: 'x' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'X' })
    await waitFor(`${field}.value==='Reviewx'`)
    await undo()
    await waitFor(`${field}.value==='Review'`)
    phase = 'native undo after keyboard selection in the invocation picker'
    await openPicker()
    await waitFor(`[...document.querySelectorAll('button[role="option"]')].some(button => button.textContent.trim()==='synthetic-ads')`)
    key('Down')
    await waitFor(`document.getElementById(${search}.getAttribute('aria-activedescendant'))?.textContent.trim()==='synthetic-ads'`)
    key('Return')
    await waitFor(`${field}.value==='Review @mcp:synthetic-ads '`)
    await undo()
    await waitFor(`${field}.value==='Review'`)
    const pickerUndo = await js('window.chatPerfFixture.composerDrafts().first')
    phase = 'native undo after keyboard selection in the mention menu'
    await wc.insertText(' @')
    await waitFor(`[...document.querySelectorAll('[role="option"]')].some(item => item.textContent.includes('synthetic-ads'))`)
    key('Return')
    await waitFor(`${field}.value==='Review @mcp:synthetic-ads '`)
    await undo()
    await waitFor(`${field}.value==='Review @'`)
    const mentionUndo = await js('window.chatPerfFixture.composerDrafts().first')
    phase = 'switch conversation during the asynchronous skill read'
    await openPicker()
    await click(skillOption)
    await waitFor('window.chatPerfFixture.skillRequested()')
    await js('window.chatPerfFixture.switchComposerSession()')
    await waitFor(`${field}?.value==='Second draft' && !${search}`)
    await js('window.chatPerfFixture.finishReadingSkill()')
    await frame()
    const composerSwitch = await js(`({drafts:window.chatPerfFixture.composerDrafts(),text:${field}.value})`)
    console.log('E2E_RESULT ' + JSON.stringify({ deepSeekThinking, mediumOnlyThinking, plainThinking, thinkingSelections, background, renamed, status, permission, content, busyError, restoredThinking, activeThinking, interruptedThinking, boardStream: { shortReasoning, longReasoning, collapsedReasoning, processAutoOpened, processManuallyOpened, punctuation, afterPunctuation }, projectionWork: { noAgent, closedAgent, openAgent, completedElapsed }, defaultRecovery, defaultRecovered, pickerUndo, mentionUndo, composerSwitch }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), phase, dimensions: await dimensions() })); process.exitCode = 1 }
  finally { clearTimeout(deadline); win?.destroy(); app.quit() }
})
