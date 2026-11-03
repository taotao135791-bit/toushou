const { app, BrowserWindow, Menu, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
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
  try {
    Menu.setApplicationMenu(null)
    const html = path.join(dir, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: false, enableLargerThanScreen: true, useContentSize: true, width: 1024, height: 700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
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
    // CI displays can have a smaller work area; preserve the viewport under test.
    win.setContentSize(1024, 700)
    app.focus({ steal: true })
    win.focus()
    wc.focus()
    const js = async source => { try { return await wc.executeJavaScript(source) } catch (error) { throw new Error(`${phase}: ${source}: ${String(error)}`) } }
    const waitFor = async expression => { const until = Date.now() + 8000; while (!await js(expression)) { if (Date.now() > until) throw new Error(`${phase}: timed out: ${expression}`); await new Promise(resolve => setTimeout(resolve, 20)) } }
    const frame = () => bounded(js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'), 'two animation frames')
    const settleMenu = async element => {
      const until = Date.now() + 8000
      let previous
      while (Date.now() < until) {
        await frame()
        const current = await js(`(() => {const e=${element};if(!e||getComputedStyle(e).visibility==='hidden')return null;const r=e.getBoundingClientRect();return r.width>0&&r.height>0?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}:null})()`)
        if (current && JSON.stringify(current) === JSON.stringify(previous)) return current
        previous = current
      }
      throw new Error(`${phase}: menu did not reach a visible, stable layout: ${element}`)
    }
    const click = (label, scope = 'document') => js(`[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`)
    const edit = (selector, value) => js(`(() => {const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const picker = `document.querySelector('[aria-label="Choose a project"]')`
    const openSidebar = async () => { await js(`document.querySelector('#sidebar-projects [aria-label="New project"]').click()`); await waitFor(`!!${picker}`); await settleMenu(`${picker}.parentElement`) }
    const openComposer = async () => { await js(`document.querySelector('#composer-projects [aria-label="Choose project"]').click()`); await waitFor(`!!${picker}`); await settleMenu(`${picker}.parentElement`) }
    const bounds = () => settleMenu(`${picker}.parentElement`)
    const beginCreate = async () => { await click('New project', picker); await waitFor(`!!document.querySelector('#project-name')`) }
    const submit = async () => { await js(`document.querySelector('#project-name').form.requestSubmit()`); await waitFor('window.projectsFixture.snapshot().pending===null') }
    const actions = name => js(`document.querySelector('[aria-label=${JSON.stringify('Project actions: ' + name)}]').click()`)
    await waitFor(`document.visibilityState==='visible' && document.hasFocus() && innerWidth===1024 && innerHeight===700`)
    await waitFor(`window.projectsFixture?.snapshot().current==='/synthetic/default' && !!document.querySelector('textarea')`)
    await edit('textarea', 'Unsent optimization brief')
    const defaultSelected = await js('window.projectsFixture.snapshot().current')
    const defaultPresentation = await js(`({hiddenInSidebar:!document.querySelector('[data-project-id="default"]'),composerText:document.querySelector('#composer-projects [aria-label="Choose project"]').textContent.trim(),composerTitle:document.querySelector('#composer-projects [aria-label="Choose project"]').title})`)
    await openSidebar()
    const defaultPicker = await js(`(() => {const e=[...${picker}.querySelectorAll('button')].find(e=>e.textContent.trim()==='No project');return {present:!!e,title:e?.title,privatePathVisible:${picker}.textContent.includes('/synthetic/default')}})()`)
    const sidebarBounds = await bounds()
    await beginCreate()
    await edit('#project-name', '中文项目')
    const ime = await js(`(() => {const e=document.querySelector('#project-name');e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));const enter=new KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true});e.dispatchEvent(enter);e.form.requestSubmit();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:229,isComposing:true,bubbles:true}));return {prevented:enter.defaultPrevented}})()`)
    await new Promise(resolve => setTimeout(resolve, 40))
    Object.assign(ime, await js(`({open:!!document.querySelector('#project-name'),creates:window.projectsFixture.creates.length})`))
    await js(`document.querySelector('#project-name').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`)
    await js(`window.projectsFixture.nextCreate='cancelled'`)
    await submit()
    const cancelledDraft = await js(`document.querySelector('#project-name').value`)
    await js(`window.projectsFixture.nextCreate='failed'`)
    await submit()
    const failedDraft = await js(`({name:document.querySelector('#project-name').value,error:!!document.querySelector('[role="alert"]')})`)
    await click('Cancel', picker)
    await waitFor(`!document.querySelector('#project-name') && !!${picker}`)
    await beginCreate()
    const formCancelDraft = await js(`document.querySelector('#project-name').value`)
    await js(`document.querySelector('#project-name').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await waitFor(`!document.querySelector('#project-name') && !!${picker}`)
    await beginCreate()
    const formEscapeDraft = await js(`document.querySelector('#project-name').value`)
    await edit('#project-name', 'Sidebar created')
    await submit()
    await waitFor(`!${picker}`)
    phase = 'composer create'
    await openComposer()
    const composerBounds = await bounds()
    const sharedAfterSidebarCreate = await js(`${picker}.textContent.includes('Sidebar created')`)
    await beginCreate()
    await edit('#project-name', 'Composer created')
    await submit()
    await waitFor(`!${picker}`)
    const sharedAfterComposerCreate = await js(`document.querySelector('#sidebar-projects').textContent.includes('Composer created')`)
    await openSidebar()
    await click('Add existing folder', picker)
    await waitFor(`!${picker}`)
    await openComposer()
    const sharedSidebarImport = await js(`${picker}.textContent.includes('Sidebar import')`)
    await click('Add existing folder', picker)
    await waitFor(`!${picker}`)
    const sharedComposerImport = await js(`document.querySelector('#sidebar-projects').textContent.includes('Composer import')`)
    phase = 'archive and restore'
    await actions('Composer import')
    await click('Archive project')
    await waitFor(`window.projectsFixture.snapshot().current==='/synthetic/default'`)
    const archiveHidden = await js(`!document.querySelector('#sidebar-projects').textContent.includes('Composer import')`)
    await openComposer()
    const archiveHiddenInComposer = await js(`!${picker}.textContent.includes('Composer import')`)
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await waitFor(`!${picker}`)
    const focusAfterEscape = await js(`document.activeElement===document.querySelector('#composer-projects [aria-label="Choose project"]')`)
    await js(`document.querySelector('#sidebar-projects [aria-label="Project options"]').click()`)
    await click('Archived projects')
    await actions('Composer import')
    await click('Restore project')
    await js(`document.querySelector('#sidebar-projects [aria-label="Project options"]').click()`)
    await click('Active projects')
    await openComposer()
    const restoredInComposer = await js(`${picker}.textContent.includes('Composer import')`)
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await waitFor(`!${picker}`)
    phase = 'path menu'
    await actions('Long path project')
    await waitFor(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Copy folder path')`)
    await settleMenu(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Copy folder path').parentElement`)
    const pathMenu = await js(`(() => {const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Copy folder path').parentElement;const r=e.getBoundingClientRect();return {complete:e.textContent.includes(window.projectsFixture.projects.find(p=>p.id==='long').path),editable:!!e.querySelector('input,textarea,[contenteditable="true"]'),top:r.top,bottom:r.bottom,height:innerHeight}})()`)
    await click('Copy folder path')
    pathMenu.copied = await js(`window.projectsFixture.clipboard===window.projectsFixture.projects.find(p=>p.id==='long').path`)
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    phase = 'delete confirmation'
    await js(`document.querySelector('#sidebar-projects button[title="/synthetic/projects/Sidebar created"]').click()`)
    await waitFor(`window.projectsFixture.snapshot().current==='/synthetic/projects/Sidebar created'`)
    await js(`window.projectsFixture.seedSession('created-3')`)
    await actions('Sidebar created')
    await click('Delete project and files…')
    await waitFor('!!window.projectsFixture.finishDelete')
    const beforeConfirmation = await js(`window.projectsFixture.snapshot().projects.some(p=>p.name==='Sidebar created')`)
    await js('window.projectsFixture.finishDelete(false)')
    await waitFor('window.projectsFixture.snapshot().pending===null')
    const afterCancelDelete = await js(`window.projectsFixture.snapshot().projects.some(p=>p.name==='Sidebar created')`)
    await actions('Sidebar created')
    await click('Delete project and files…')
    await waitFor('!!window.projectsFixture.finishDelete')
    await js('window.projectsFixture.finishDelete(true)')
    await waitFor(`!window.projectsFixture.snapshot().projects.some(p=>p.name==='Sidebar created')`)
    await js(`window.dispatchEvent(new Event('focus'))`)
    await waitFor('window.projectsFixture.snapshot().pending===null')
    const afterDelete = await js(`window.projectsFixture.snapshot()`)
    const composerDraft = await js(`document.querySelector('textarea').value`)
    console.log('E2E_RESULT ' + JSON.stringify({ defaultSelected, defaultPresentation, defaultPicker, sidebarBounds, composerBounds, ime, cancelledDraft, failedDraft, formCancelDraft, formEscapeDraft, sharedAfterSidebarCreate, sharedAfterComposerCreate, sharedSidebarImport, sharedComposerImport, archiveHidden, archiveHiddenInComposer, focusAfterEscape, restoredInComposer, pathMenu, beforeConfirmation, afterCancelDelete, afterDelete, composerDraft }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), phase, dimensions: await dimensions() })); process.exitCode = 1 }
  finally { win?.destroy(); app.quit() }
})
