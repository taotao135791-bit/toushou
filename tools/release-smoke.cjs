/* CI only: run the actual staged packaged executable against a synthetic profile. */
const { spawn } = require('node:child_process')
const { mkdtempSync, mkdirSync, existsSync, statSync, writeFileSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { createServer } = require('node:net')
const os = require('node:os')
const path = require('node:path')

if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Packaged smoke is restricted to GitHub Actions runners.')
}
const executable = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (!executable || !existsSync(executable) || !statSync(executable).isFile()) {
  throw new Error('Expected the path to the staged packaged executable.')
}

const root = mkdtempSync(path.join(os.tmpdir(), 'toushou-package-smoke-'))
const profile = path.join(root, 'profile')
const privateHome = path.join(root, 'home')
for (const dir of [profile, privateHome, path.join(privateHome, 'Documents'), path.join(root, 'tmp'), path.join(root, 'omp'), path.join(root, 'omp', 'agent')]) mkdirSync(dir, { recursive: true, mode: 0o700 })
const environment = {}
for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'DISPLAY']) {
  if (process.env[key]) environment[key] = process.env[key]
}
// On macOS preserve HOME for the OS keychain, while isolating Foundation's
// home, application profile, temporary paths, and the OMP configuration.
environment.HOME = process.platform === 'darwin' ? process.env.HOME : privateHome
environment.CFFIXED_USER_HOME = privateHome
environment.USERPROFILE = privateHome
environment.APPDATA = path.join(privateHome, 'appdata')
environment.LOCALAPPDATA = path.join(privateHome, 'localappdata')
environment.XDG_CONFIG_HOME = path.join(privateHome, 'xdg-config')
environment.XDG_DATA_HOME = path.join(privateHome, 'xdg-data')
environment.XDG_CACHE_HOME = path.join(privateHome, 'xdg-cache')
environment.PI_CODING_AGENT_DIR = path.join(root, 'omp', 'agent')
environment.TMPDIR = environment.TMP = environment.TEMP = path.join(root, 'tmp')
for (const dir of [environment.APPDATA, environment.LOCALAPPDATA, environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_CACHE_HOME]) mkdirSync(dir, { recursive: true, mode: 0o700 })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, timeout, label) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last } catch (error) { last = error }
    await sleep(150)
  }
  throw new Error(`${label} timed out${last instanceof Error ? `: ${last.message}` : ''}`)
}
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate loopback port')
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 0
    const failPending = error => { for (const item of pending.values()) item.reject(error); pending.clear() }
    socket.addEventListener('error', () => { failPending(new Error('CDP socket error')); reject(new Error('CDP socket error')) }, { once: true })
    socket.addEventListener('close', () => failPending(new Error('CDP socket closed')))
    socket.addEventListener('message', event => {
      const data = JSON.parse(String(event.data))
      if (!data.id) return
      const request = pending.get(data.id)
      if (!request) return
      pending.delete(data.id)
      if (data.error) request.reject(new Error(data.error.message))
      else request.resolve(data.result)
    })
    socket.addEventListener('open', () => resolve({
      close: () => socket.close(),
      send: (method, params = {}) => new Promise((fulfil, rejectRequest) => {
        const id = ++nextId
        pending.set(id, { resolve: fulfil, reject: rejectRequest })
        socket.send(JSON.stringify({ id, method, params }))
      })
    }), { once: true })
  })
}
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`)
  return result.result.value
}

let child, cdp, output = ''
const running = process_ => process_ && process_.exitCode === null && process_.signalCode === null
function processState(target) {
  return `pid=${target?.pid ?? 'none'} exit=${target?.exitCode ?? 'none'} signal=${target?.signalCode ?? 'none'}`
}

/** Bounded, asynchronous taskkill lets Node observe the packaged child's exit. */
async function killWindowsTree(pid) {
  const started = Date.now()
  return new Promise(resolve => {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT
    const command = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
    let killer
    let detail = ''
    const collect = chunk => { if (detail.length < 1024) detail += String(chunk).slice(0, 1024 - detail.length) }
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      console.log(`[smoke-cleanup] phase=taskkill pid=${pid} status=${result.status ?? 'none'} error=${result.error ?? 'none'} elapsedMs=${Date.now() - started}`)
      if ((result.status !== 0 || result.error) && detail) console.error(`[smoke-cleanup] phase=taskkill-output detail=${JSON.stringify(detail)}`)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      try { killer?.kill('SIGKILL') } catch { /* timed-out utility */ }
      killer?.stdout?.destroy()
      killer?.stderr?.destroy()
      killer?.unref()
      finish({ status: null, error: 'timeout' })
    }, 8000)
    try {
      killer = spawn(command, ['/pid', String(pid), '/t', '/f'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      killer.stdout?.on('data', collect)
      killer.stderr?.on('data', collect)
      killer.once('error', error => finish({ status: null, error: error.code || 'spawn-failed' }))
      killer.once('close', (status, signal) => finish({ status, error: signal ? 'signal' : null }))
    } catch (error) { finish({ status: null, error: error.code || 'spawn-failed' }) }
  })
}
async function stopChild(phase = 'stop') {
  const target = child
  console.log(`[smoke-cleanup] phase=${phase}-begin ${processState(target)}`)
  if (!running(target)) return
  const stopped = new Promise(resolve => target.once('exit', resolve))
  let treeFailure = false
  if (process.platform === 'win32' && target.pid) {
    const result = await killWindowsTree(target.pid)
    treeFailure = result.status !== 0 || !!result.error
  } else {
    try { target.kill('SIGTERM') } catch { /* checked against real exit below */ }
  }
  await Promise.race([stopped, sleep(3000)])
  if (running(target)) {
    console.log(`[smoke-cleanup] phase=${phase}-fallback ${processState(target)}`)
    try { target.kill('SIGKILL') } catch { /* checked against real exit below */ }
    await Promise.race([stopped, sleep(2000)])
  }
  console.log(`[smoke-cleanup] phase=${phase}-end ${processState(target)}`)
  if (running(target)) throw new Error('Packaged app did not exit')
  if (treeFailure) throw new Error('Packaged app process tree termination could not be confirmed')
}
async function launch(port) {
  child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  child.once('error', error => { output = `${output}\nlaunch error: ${error.message}` })
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-12_000) })
  const target = await until(async () => {
    if (!running(child)) throw new Error(`Packaged app exited (${child.exitCode ?? child.signalCode})`)
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
    if (!response.ok) return null
    return (await response.json()).find(item => item.type === 'page' && typeof item.url === 'string' && item.url.startsWith('file:') && item.webSocketDebuggerUrl)
  }, 30_000, 'Packaged renderer')
  // Verify app.getPath('userData') really follows the profile switch before
  // creating any reading; never silently test another application profile.
  await until(() => existsSync(path.join(profile, 'logs', 'main.log')), 10_000, 'Isolated app profile')
  cdp = await connect(target.webSocketDebuggerUrl)
  await until(() => evaluate(cdp, `typeof window.electronAPI?.saveReadingSnapshot === 'function' && !!document.body`), 15_000, 'Preload and page')
}
async function run() {
  // electron-store reads this file when Main starts. Seed only the two values
  // this synthetic profile needs, before the renderer can hydrate them. The
  // exclusive create prevents overwriting an unexpected existing profile file.
  writeFileSync(path.join(profile, 'omp-gui-settings.json'), JSON.stringify({ setupComplete: true, language: 'en' }), { flag: 'wx', mode: 0o600 })
  const firstPort = await freePort()
  await launch(firstPort)
  const setup = await evaluate(cdp, `(async () => ({setupComplete:await window.electronAPI.getStore('setupComplete'),language:await window.electronAPI.getStore('language')}))()`)
  if (setup?.setupComplete !== true || setup?.language !== 'en') {
    throw new Error(`Could not read isolated first-run preferences: ${JSON.stringify({ setupComplete: setup?.setupComplete === true, languageIsEnglish: setup?.language === 'en' })}`)
  }
  const seed = await evaluate(cdp, `(async () => {
    const windowRange={start:'2026-01-01',end:'2026-01-02'};
    const snapshot={kind:'reading-snapshot',version:1,rangeLabel:'Synthetic range',window:windowRange,capturedAt:1000,accounts:[{platform:'tiktok',accountId:'SYNTHETIC_ID',name:'Synthetic account',status:'ok',statusDetail:null,window:windowRange,previousWindow:null,sourceAt:900,timezone:'UTC',currency:'USD',spend:42,previousSpend:null,impressions:100,clicks:3,conversions:1}]};
    const board=await window.electronAPI.saveReadingSnapshot({name:'Synthetic package board',snapshot,includeChart:true,presentation:'report',language:'en'});
    if(!board.ok) return {stage:'snapshot',error:board.error};
    const widgetId=board.widgetId, boardId=board.board.id;
    const opened=await window.electronAPI.loadOrCreateHtmlBoard({boardId,widgetId,language:'en'});
    if(!opened.ok) return {stage:'open',error:opened.error};
    const saved=await window.electronAPI.saveHtmlBoard({id:opened.document.id,expectedRevision:opened.document.revision,html:'<h1>Packaged smoke layout</h1><div data-reading-slot></div>',css:'h1 { color: #123456; }',theme:'minimal'});
    if(!saved.ok) return {stage:'save',error:saved.error};
    const found=await window.electronAPI.findHtmlBoardForReading({boardId,widgetId});
    const modular=await window.electronAPI.saveReadingSnapshot({name:'Synthetic modular board',snapshot,includeChart:true,language:'en'});
    if(!modular.ok) return {stage:'modular-save',error:modular.error};
    const modules=modular.board.widgets.filter(w=>w.type==='reading-module');
    const charts=modules.filter(w=>w.config.module?.kind==='spend-chart');
    const focused=modules.find(w=>w.id===modular.focusWidgetId);
    const source=modular.board.widgets.find(w=>w.id===modular.widgetId);
    const moduleDoc=await window.electronAPI.findHtmlBoardForReading({boardId:modular.board.id,widgetId:modular.focusWidgetId,language:'en'});
    const all=await window.electronAPI.listBoards();
    return {ok:found.ok && found.document.revision===saved.document.revision && found.document.html===saved.document.html && all.some(b=>b.id===boardId) && modules.length>=4 && charts.length===2 && !!focused && source?.type==='reading-snapshot' && moduleDoc.ok && moduleDoc.document.mode==='module',boardId,widgetId,modularBoardId:modular.board.id,focusWidgetId:modular.focusWidgetId,sourceWidgetId:modular.widgetId,chartIds:charts.map(w=>w.id)};
  })()`)
  if (!seed?.ok) throw new Error(`Packaged persistence failed at ${seed?.stage ?? 'read-back'}`)
  // Restart the actual packaged process and verify the saved data again.
  cdp.close(); cdp = null
  await stopChild('restart')
  // Windows can keep the first listener's port unavailable after the process
  // exits. Allocate a fresh loopback port for the restarted packaged app.
  const restartPort = await freePort()
  if (restartPort === firstPort) throw new Error('Could not allocate a fresh restart port')
  await launch(restartPort)
  const reopened = await evaluate(cdp, `(async () => {const r=await window.electronAPI.findHtmlBoardForReading({boardId:${JSON.stringify(seed.boardId)},widgetId:${JSON.stringify(seed.widgetId)}});const all=await window.electronAPI.listBoards();const b=all.find(x=>x.id===${JSON.stringify(seed.modularBoardId)});return await window.electronAPI.getStore('setupComplete')===true && await window.electronAPI.getStore('language')==='en' && r.ok&&r.document.html.includes('Packaged smoke layout') && b?.widgets.some(w=>w.id===${JSON.stringify(seed.focusWidgetId)}&&w.type==='reading-module') && b.widgets.some(w=>w.id===${JSON.stringify(seed.sourceWidgetId)}&&w.type==='reading-snapshot') && ${JSON.stringify(seed.chartIds)}.every(id=>b.widgets.some(w=>w.id===id&&w.config.module?.kind==='spend-chart'))})()`)
  if (!reopened) throw new Error('Saved HTML did not survive application restart')
  // Reload the unmodified renderer to exercise persisted data through its UI.
  await evaluate(cdp, `window.location.hash='#/boards'; true`)
  await cdp.send('Page.reload')
  await until(() => evaluate(cdp, `!!window.electronAPI && document.body?.textContent?.includes('Synthetic package board')`), 20_000, 'Board list after reload')
  await evaluate(cdp, `(() => {const tab=[...document.querySelectorAll('[title="Click to open · drag to reorder tabs"]')].find(e=>e.textContent.includes('Synthetic package board'));if(!tab)throw Error('missing board tab');tab.click();return true})()`)
  await until(() => evaluate(cdp, `!!document.querySelector('iframe[title="Saved board"]')?.srcdoc.includes('Packaged smoke layout')`), 15_000, 'Saved layout in board')
  const layout = await evaluate(cdp, `(() => {const f=document.querySelector('iframe[title="Saved board"]');return {sandbox:f?.getAttribute('sandbox'),content:f?.srcdoc}})()`)
  if (layout?.sandbox !== '' || !layout.content.includes('Synthetic account') || !layout.content.includes('42')) throw new Error('Saved layout is missing source data or sandbox')
  await evaluate(cdp, `(() => {const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='View source readings');if(!b)throw Error('missing source control');b.click();return true})()`)
  await until(() => evaluate(cdp, `document.body.textContent.includes('Synthetic account') && !!document.querySelector('[data-reading-account-index="1"]')`), 10_000, 'Source reading')
  await evaluate(cdp, `(() => {const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Show saved layout');if(!b)throw Error('missing saved-layout control');b.click();return true})()`)
  await until(() => evaluate(cdp, `!!document.querySelector('iframe[title="Saved board"]')?.srcdoc.includes('Packaged smoke layout')`), 10_000, 'Return to saved layout')
  await evaluate(cdp, `(() => {const tab=[...document.querySelectorAll('[title="Click to open · drag to reorder tabs"]')].find(e=>e.textContent.includes('Synthetic modular board'));if(!tab)throw Error('missing modular board tab');tab.click();return true})()`)
  await until(() => evaluate(cdp, `${JSON.stringify(seed.chartIds)}.every(id=>!!document.querySelector('[data-board-widget-id="'+id+'"] iframe'))`), 15_000, 'Modular charts rendered')
  const modules = await evaluate(cdp, `(() => {const ids=${JSON.stringify(seed.chartIds)},grid=document.querySelector('.react-grid-layout').getBoundingClientRect();const rows=ids.map(id=>{const card=document.querySelector('[data-board-widget-id="'+id+'"]'),frame=card.querySelector('iframe'),r=card.getBoundingClientRect(),f=frame.getBoundingClientRect(),doc=new DOMParser().parseFromString(frame.srcdoc,'text/html');return {x:r.x,y:r.y,right:r.right,width:r.width,frameWidth:f.width,frameHeight:f.height,sandbox:frame.getAttribute('sandbox'),fullTable:!!doc.querySelector('.table-wrap'),footer:!!doc.querySelector('.module-source'),script:!!doc.querySelector('script')}});return {gridWidth:grid.width,rows}})()`)
  if (modules.rows.length !== 2 || modules.rows.some(row => row.sandbox !== '' || row.fullTable || !row.footer || row.script || row.width < modules.gridWidth * 0.4 || row.frameWidth < 100 || row.frameHeight < 100) || Math.abs(modules.rows[0].y - modules.rows[1].y) > 2 || modules.rows[0].right > modules.rows[1].x + 1) throw new Error('Modular chart layout or compact source preview is invalid')
  console.log('Packaged app functional assertions passed: private profile, full report and modular snapshot persistence, separate chart layouts, and source navigation.')
}
let timer
Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged smoke exceeded 90 seconds')), 90_000) })]).catch(error => { process.exitCode = 1; console.error(`Packaged app smoke failed: ${error.message}`); if (output) console.error(output) }).finally(async () => {
  clearTimeout(timer)
  // Bound cleanup even when a subprocess, socket or filesystem operation stalls.
  const cleanupDeadline = setTimeout(() => {
    process.exitCode = 1
    console.error(`[smoke-cleanup] phase=deadline ${processState(child)}`)
    try { if (running(child)) child.kill('SIGKILL') } catch { /* report failure below */ }
    process.exit(1)
  }, 20000)
  try { cdp?.close() } catch { /* already closed */ }
  try { await stopChild('final') } catch (error) { process.exitCode = 1; console.error(error.message) }
  try {
    await Promise.race([
      // Windows can briefly retain a killed Chromium process's file handles.
      // Retry only filesystem-defined transient errors, within the same strict
      // cleanup deadline; a persistent lock still fails the smoke.
      rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      sleep(8000).then(() => { throw new Error('Synthetic profile cleanup timed out') })
    ])
  } catch (error) {
    process.exitCode = 1
    const relative = typeof error.path === 'string' ? path.relative(root, error.path) : ''
    const target = relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) ? relative : '.'
    console.error(`[smoke-cleanup] phase=profile error=${error.code || error.message} target=${JSON.stringify(target)}`)
  }
  child?.stdout?.destroy()
  child?.stderr?.destroy()
  if (!process.exitCode) console.log('Packaged app smoke passed (including process cleanup).')
  // Give the runner time to receive the final diagnostics before bounded exit.
  await Promise.race([
    Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve)))),
    sleep(500)
  ])
  clearTimeout(cleanupDeadline)
  // A lingering WebSocket or descendant pipe must not hold the CI step open.
  process.exit(process.exitCode || 0)
})
