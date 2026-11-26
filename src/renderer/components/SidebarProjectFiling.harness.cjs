const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const [, , dir, phase] = process.argv
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  const store = require(path.join(dir, 'filing.cjs'))
  ipcMain.handle('read', () => store.getStore('sidebarSessionProjects'))
  ipcMain.handle('file', (_event, key, project, previous, migrate) => store.fileSidebarConversation(key, project, previous, migrate, id => ['alpha', 'beta'].includes(id)))
  const agentDir = path.join(dir, 'omp-profile')
  const sourceDir = path.join(agentDir, 'sessions', 'legacy-layout')
  fs.mkdirSync(sourceDir, { recursive: true })
  const projects = { alpha: '/synthetic/client-a/project', beta: '/synthetic/client-b/project' }
  const folders = Object.fromEntries(Object.keys(projects).map(id => {
    const folder = path.join(dir, id)
    fs.mkdirSync(folder, { recursive: true })
    return [id, fs.realpathSync.native(folder)]
  }))
  const idForCwd = cwd => Object.keys(projects).find(id => projects[id] === cwd)
  const rowForFile = ({ cwd, filePath, ...row }) => ({ ...row, cwd: projects[Object.keys(folders).find(id => folders[id] === cwd)] })
  const seed = row => {
    const filename = path.join(sourceDir, `${row.uuid}.jsonl`)
    fs.writeFileSync(filename, JSON.stringify({ type: 'session', id: row.uuid, cwd: folders[idForCwd(row.cwd)], timestamp: new Date(row.timestamp).toISOString() }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: 'Synthetic original context' } }) + '\n', { flag: 'wx' })
  }
  const fixtureUuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
  if (phase === 'save') for (const n of [1, 3]) seed({ uuid: fixtureUuid(n), cwd: projects.alpha, timestamp: 100 + n })
  ipcMain.handle('rows', async () => (await store.listAllSessions(agentDir)).map(rowForFile))
  ipcMain.handle('seed', (_event, row) => seed(row))
  ipcMain.handle('move', async (_event, _grant, key, target) => {
    const [cwd, uuid] = JSON.parse(key)
    const source = folders[idForCwd(cwd)]
    if (!source || !folders[target]) return { ok: false, error: 'not-found' }
    const result = await store.moveSessionJournal({ source, uuid, target: folders[target], agentDir, available: () => true, prepare: async () => true })
    if (!result.ok) return result
    const row = (await store.listAllSessions(agentDir)).find(row => row.uuid === uuid)
    const retired = phase === 'save' && uuid === fixtureUuid(1) ? ['live-a'] : phase === 'save' && uuid === fixtureUuid(59) ? ['new-runtime'] : []
    return { ok: true, row: rowForFile(row), retiredSessionIds: retired }
  })
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 1024, height: 700, webPreferences: { offscreen: phase === 'scrollbar', sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(dir, 'bridge.cjs') } })
  const wc = win.webContents
  wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, reply) => reply({ cancel: true }))
  wc.on('console-message', (_e, level, message) => { if (level >= 3) console.error(message) })
  const js = code => wc.executeJavaScript(code)
  const wait = async expression => {
    const deadline = Date.now() + 4000
    while (!await js(expression)) {
      if (Date.now() > deadline) throw new Error(phase + ' timed out: ' + expression)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const row = (scope, identity) => `[...document.querySelectorAll('${scope} [data-conversation-key]')].find(el=>JSON.parse(el.dataset.conversationKey)[1]===${identity})`
  const id = n => `sidebarFixture.uuid(${n})`
  const all = '[data-all-conversations]', group = p => `[data-project-conversations=${p}]`
  const header = p => `document.querySelector('[data-project-id=${p}] [draggable]')`
  async function drag(from, to) {
    await wait(from)
    await js(`(()=>{const from=${from},to=${to},d=new DataTransfer();const drag=type=>new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:d});from.dispatchEvent(drag('dragstart'));to.dispatchEvent(drag('dragover'));to.dispatchEvent(drag('drop'));from.dispatchEvent(drag('dragend'))})()`)
  }
  try {
    await win.loadFile(path.join(dir,'index.html'), {query:{phase}})
    await wait(row(all,id(3)))
    if (phase === 'save') {
      await drag(row(all,id(3)),header('beta')); await wait(row(group('beta'),id(3)))
      await js('filingFixture.addFresh()')
      await drag(row(all,"'runtime:new-runtime'"),header('beta'))
      await wait("document.body.textContent.includes('Could not move the conversation')")
      await js('filingFixture.publishDurable()')
      await drag(row(all,id(59)),header('beta')); await wait(row(group('beta'),id(59)))
      assert.equal(await js('sidebarFixture.activateCalls.length+sidebarFixture.resumeCalls.length'),0)
      await drag(row(all,id(1)),header('beta')); await wait(row(group('beta'),id(1)))
      await wait("sidebarFixture.snapshot().current==='resumed-'+sidebarFixture.uuid(1) && document.body.textContent.includes('Synthetic original context')")
      assert.equal(await js('sidebarFixture.resumeCalls.at(-1).grantId'),'grant-beta')
      assert.equal(await js('sidebarFixture.snapshot().workspace'),projects.beta)
      assert.equal(await js('document.querySelector("main header").textContent.includes("Beta")'),true)
    } else if (phase === 'cold') {
      await js("document.querySelector('[aria-label=\"Conversations in Beta\"]').click()")
      for (const n of [1,3,59]) await wait(row(group('beta'),id(n)))
      // The same history can be moved from inside a project after restart.
      await drag(row(group('beta'),id(3)),header('alpha')); await wait(row(group('alpha'),id(3)))
      await wait('!('+row(group('beta'),id(3))+')')
      // Open the filed historical row from another active workspace.
      await js(`${header('beta')}.querySelector('button[title]').click()`)
      await wait("sidebarFixture.snapshot().workspace==='/synthetic/client-b/project'")
      await js(`${row(group('beta'),id(1))}.querySelector('[data-conversation-select]').click()`)
      await wait("sidebarFixture.snapshot().current==='resumed-'+sidebarFixture.uuid(1) && document.body.textContent.includes('Synthetic original context')")
      assert.equal(await js('sidebarFixture.resumeCalls.at(-1).grantId'),'grant-beta')
      assert.equal(await js('sidebarFixture.snapshot().workspace'),projects.beta)
      await js(`(() => { const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Continue the original topic');input.dispatchEvent(new Event('input',{bubbles:true})) })()`)
      await wait("document.querySelector('[aria-label=Send]')?.disabled===false")
      await js("document.querySelector('[aria-label=Send]').click()")
      await wait("sidebarFixture.sent.some(call=>call.id==='resumed-'+sidebarFixture.uuid(1)&&call.text==='Continue the original topic')")
    } else if (phase === 'reopen') {
      await js("document.querySelector('[aria-label=\"Conversations in Alpha\"]').click();document.querySelector('[aria-label=\"Conversations in Beta\"]').click()")
      await wait(row(group('alpha'),id(3))); await wait(row(group('beta'),id(1))); await wait(row(group('beta'),id(59)))
      assert.equal(await js('filingBridge.read().then(map=>Object.keys(map).length)'),0)
    }
    if (phase === 'scrollbar') {
      // Chromium receives mouse input; measure the actual painted gutter as
      // the native thumb is hovered, dragged out, released and wheel-scrolled.
      const box = await js(`(() => {const el=document.querySelector('[data-sidebar-scroll]'),r=el.getBoundingClientRect();return { x:Math.floor(r.right)-3, y:Math.ceil(r.top), h:Math.floor(r.height), gutter:el.offsetWidth-el.clientWidth }})()`)
      assert(box.gutter > 0)
      const startY = box.y + 10, endY = box.y + Math.floor(box.h / 2)
      const settle = () => new Promise(resolve => setTimeout(resolve, 90))
      const move = (x,y,down=false) => wc.sendInputEvent({type:'mouseMove',x,y,...down && {button:'left',modifiers:['leftButtonDown']}})
      const band = async () => { await settle(); return (await win.capturePage({x:box.x,y:box.y+1,width:1,height:box.h-2})).toBitmap() }
      const changes = (a,b) => { let diff=0; for(let i=0;i<a.length;i+=4) if (Math.abs(a[i]-b[i])>12) diff++;return diff }
      const offset = () => js("document.querySelector('[data-sidebar-scroll]').scrollTop")
      move(box.x-20,startY);const idle=await band()
      move(box.x,startY);const hovered=await band()
      assert(changes(idle,hovered)>4, 'hover must reveal the thumb '+JSON.stringify(box))
      wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:box.x,y:startY})
      move(box.x+40,endY,true);const dragged=await band()
      const afterDrag = await offset()
      const hit = await js(`(() => { const e=document.elementFromPoint(${box.x},${startY});return [e?.className,document.querySelector('aside')?.getBoundingClientRect().width] })()`)
      assert(afterDrag>0 && changes(idle,dragged)>4, 'native drag should scroll with visible thumb '+JSON.stringify({box,afterDrag,idleDiff:changes(idle,dragged),hit}))
      wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:box.x+40,y:endY})
      move(box.x+40,endY+1);const released=await band()
      assert(changes(idle,released)<4,'thumb should hide on release outside')
      wc.sendInputEvent({type:'mouseWheel',x:box.x-40,y:endY,deltaY:50,deltaX:0})
      const wheeled=await band()
      assert.notEqual(await offset(),afterDrag)
      assert(changes(idle,wheeled)<4,'wheel scrolling over the content should keep the thumb hidden')
    }
    console.log('FILING_OK '+phase)
    app.exit(0)
  } catch (e) { console.error(e); app.exit(1) }
}).catch(e => { console.error(e); app.exit(1) })
