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
  const projects = { default: '/synthetic/TouShou workspace', alpha: '/synthetic/client-a/project', beta: '/synthetic/client-b/project' }
  const folders = Object.fromEntries(Object.keys(projects).map(id => {
    const folder = path.join(dir, id)
    fs.mkdirSync(folder, { recursive: true })
    return [id, fs.realpathSync.native(folder)]
  }))
  const idForCwd = cwd => Object.keys(projects).find(id => projects[id] === cwd)
  const rowForFile = ({ cwd, filePath, ...row }) => ({ ...row, cwd: projects[Object.keys(folders).find(id => folders[id] === cwd)] })
  const seed = row => {
    const filename = path.join(sourceDir, `${row.uuid}.jsonl`)
    const journal = [
      { type: 'session', id: row.uuid, cwd: folders[idForCwd(row.cwd)], timestamp: new Date(row.timestamp).toISOString() },
      { type: 'message', message: { role: 'user', content: 'Synthetic original context' } },
      { type: 'message', message: { role: 'assistant', content: 'Synthetic 对话答复' } },
      { type: 'custom', data: { final: true } }
    ].map(record => JSON.stringify(record)).join('\n') + '\n'
    fs.writeFileSync(filename, journal, { flag: 'wx' })
  }
  const fixtureUuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
  if (phase === 'save') {
    for (const n of [1, 3]) seed({ uuid: fixtureUuid(n), cwd: projects.alpha, timestamp: 100 + n })
    for (const n of [5, 60]) seed({ uuid: fixtureUuid(n), cwd: projects.default, timestamp: 300 + n })
  }
  ipcMain.handle('rows', async () => (await store.listAllSessions(agentDir)).map(rowForFile))
  ipcMain.handle('seed', (_event, row) => seed(row))
  ipcMain.handle('move', async (_event, _grant, key, target, liveSessionId) => {
    const [cwd, uuid] = JSON.parse(key)
    const source = folders[idForCwd(cwd)]
    if (!source || !folders[target]) return { ok: false, error: 'not-found' }
    const result = await store.moveSessionJournal({ source, uuid, target: folders[target], agentDir, available: () => true, prepare: async () => true })
    if (!result.ok) return result
    const row = (await store.listAllSessions(agentDir)).find(row => row.uuid === uuid)
    return { ok: true, row: rowForFile(row), retiredSessionIds: liveSessionId ? [liveSessionId] : [] }
  })
  async function journal(n) {
    const rows = (await store.listAllSessions(agentDir)).filter(row => row.uuid === fixtureUuid(n))
    assert.equal(rows.length, 1, 'journal must remain uniquely discoverable')
    const [row] = rows
    return { row, bytes: fs.readFileSync(row.filePath) }
  }
  async function assertJournalProject(n, project) {
    const snapshot = await journal(n)
    const cwd = folders[project]
    assert.equal(snapshot.row.cwd, cwd)
    const [targetDirectory] = store.ompSessionDirCandidatesFor(cwd, agentDir, fs.realpathSync.native)
    assert.equal(path.dirname(snapshot.row.filePath), targetDirectory)
    return snapshot
  }
  async function assertJournalMoved(n, before, project) {
    const after = await assertJournalProject(n, project)
    assert.equal(fs.existsSync(before.row.filePath), false, 'the original journal must be removed')
    assert.equal(path.basename(after.row.filePath), path.basename(before.row.filePath))
    const lineEnd = before.bytes.indexOf(10)
    const header = JSON.parse(before.bytes.subarray(0, lineEnd).toString())
    const expected = Buffer.concat([
      Buffer.from(JSON.stringify({ ...header, cwd: folders[project] }) + '\n'),
      before.bytes.subarray(lineEnd + 1)
    ])
    assert.deepEqual(after.bytes, expected, 'only the session header cwd may change')
  }
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
  const sessionProject = p => `document.querySelector('main header [data-session-project=${p}]')`
  const assertDefaultHeader = () => wait("document.querySelector('main header') && !document.querySelector('main header [data-session-project]') && !document.querySelector('main header').textContent.includes('TouShou workspace')")
  async function drag(from, to) {
    await wait(from)
    await js(`(()=>{const from=${from},to=${to},d=new DataTransfer();const drag=type=>new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:d});from.dispatchEvent(drag('dragstart'));to.dispatchEvent(drag('dragover'));to.dispatchEvent(drag('drop'));from.dispatchEvent(drag('dragend'))})()`)
  }
  try {
    await win.loadFile(path.join(dir,'index.html'), {query:{phase}})
    await wait(row(all,id(3)))
    if (phase === 'save') {
      await wait(sessionProject('alpha'))
      const historyBefore = await journal(3)
      await drag(row(all,id(3)),header('beta')); await wait(row(group('beta'),id(3)))
      await assertJournalMoved(3, historyBefore, 'beta')
      assert.equal(await js('sidebarFixture.snapshot().current'), 'live-a')
      assert.equal(await js(`Boolean(${sessionProject('alpha')})`), true)
      await js('filingFixture.addFresh()')
      await drag(row(all,"'runtime:new-runtime'"),header('beta'))
      await wait("document.body.textContent.includes('Could not move the conversation')")
      await js('filingFixture.publishDurable()')
      await drag(row(all,id(59)),header('beta')); await wait(row(group('beta'),id(59)))
      assert.equal(await js('sidebarFixture.activateCalls.length+sidebarFixture.resumeCalls.length'),0)
      const liveBefore = await journal(1)
      await drag(row(all,id(1)),header('beta')); await wait(row(group('beta'),id(1)))
      await wait("sidebarFixture.snapshot().current==='resumed-'+sidebarFixture.uuid(1) && document.body.textContent.includes('Synthetic original context')")
      await assertJournalMoved(1, liveBefore, 'beta')
      assert.equal(await js('sidebarFixture.resumeCalls.at(-1).grantId'),'grant-beta')
      assert.equal(await js('sidebarFixture.snapshot().workspace'),projects.beta)
      await wait(`${sessionProject('beta')}?.textContent.trim()==='Beta'`)

      await js('filingFixture.openDefaultLive()')
      await wait("sidebarFixture.snapshot().current==='live-default'")
      await assertDefaultHeader()
      const defaultBefore = await journal(5)
      await drag(row(all,id(5)),header('beta')); await wait(row(group('beta'),id(5)))
      await wait(`sidebarFixture.snapshot().current==='resumed-'+${id(5)} && ${sessionProject('beta')}?.textContent.trim()==='Beta'`)
      assert.equal(await js('sidebarFixture.resumeCalls.at(-1).grantId'), 'grant-beta')
      await assertJournalMoved(5, defaultBefore, 'beta')

      await js('filingFixture.openDefaultPreviewWithoutHistoryRow()')
      await wait("sidebarFixture.snapshot().current==='preview:detached-history-fixture'")
      await assertDefaultHeader()
      const previewBefore = await journal(60)
      await drag(row(all,id(60)),header('beta')); await wait(row(group('beta'),id(60)))
      await wait(`sidebarFixture.snapshot().current==='resumed-'+${id(60)} && ${sessionProject('beta')}?.textContent.trim()==='Beta'`)
      await assertJournalMoved(60, previewBefore, 'beta')

      // If the user changes chats while the move is pending, keep the newer selection.
      const movingBefore = await journal(60)
      await js('filingFixture.pauseNextMove()')
      await drag(row(group('beta'),id(60)),header('alpha'))
      await wait('filingFixture.waitingForMove()')
      await js(`${row(group('beta'),id(2))}.querySelector('[data-conversation-select]').click()`)
      await wait("sidebarFixture.snapshot().current==='live-b'")
      const navigationCount = 'sidebarFixture.activateCalls.length+sidebarFixture.resumeCalls.length'
      const beforeRelease = await js(navigationCount)
      await js('filingFixture.releaseMove()')
      await wait(row(group('alpha'),id(60)))
      assert.equal(await js('sidebarFixture.snapshot().current'), 'live-b')
      assert.equal(await js(`Boolean(${sessionProject('beta')})`), true)
      assert.equal(await js(navigationCount), beforeRelease, 'completed move must not restart navigation')
      await assertJournalMoved(60, movingBefore, 'alpha')
    } else if (phase === 'cold') {
      await js("document.querySelector('[aria-label=\"Conversations in Beta\"]').click()")
      for (const n of [1,3,5,59]) await wait(row(group('beta'),id(n)))
      await assertJournalProject(5, 'beta')
      await assertJournalProject(60, 'alpha')
      // The same history can be moved from inside a project after restart.
      await drag(row(group('beta'),id(3)),header('alpha')); await wait(row(group('alpha'),id(3)))
      await wait('!('+row(group('beta'),id(3))+')')
      // Open the filed historical row from another active workspace.
      await js(`${header('beta')}.querySelector('button[title]').click()`)
      await wait("sidebarFixture.snapshot().workspace==='/synthetic/client-b/project'")
      await js(`${row(group('beta'),id(5))}.querySelector('[data-conversation-select]').click()`)
      await wait(`sidebarFixture.snapshot().current==='resumed-'+${id(5)} && document.body.textContent.includes('Synthetic original context')`)
      assert.equal(await js('sidebarFixture.resumeCalls.at(-1).grantId'),'grant-beta')
      assert.equal(await js('sidebarFixture.snapshot().workspace'),projects.beta)
      await wait(`${sessionProject('beta')}?.textContent.trim()==='Beta'`)
      await js(`(() => { const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Continue the original topic');input.dispatchEvent(new Event('input',{bubbles:true})) })()`)
      await wait("document.querySelector('[aria-label=Send]')?.disabled===false")
      await js("document.querySelector('[aria-label=Send]').click()")
      await wait("sidebarFixture.sent.some(call=>call.id==='resumed-'+sidebarFixture.uuid(5)&&call.text==='Continue the original topic')")
    } else if (phase === 'reopen') {
      await js("document.querySelector('[aria-label=\"Conversations in Alpha\"]').click();document.querySelector('[aria-label=\"Conversations in Beta\"]').click()")
      await wait(row(group('alpha'),id(3))); await wait(row(group('beta'),id(1))); await wait(row(group('beta'),id(59)))
      await wait(row(group('alpha'),id(60))); await wait(row(group('beta'),id(5)))
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
