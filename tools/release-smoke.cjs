/* CI only: run the actual staged packaged executable against a synthetic profile. */
const { spawn, spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, existsSync, rmSync, statSync } = require('node:fs')
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
environment.PI_CONFIG_DIR = path.join(root, 'omp')
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
async function stopChild() {
  if (!running(child)) return
  const stopped = new Promise(resolve => child.once('exit', resolve))
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
  await Promise.race([stopped, sleep(3000)])
  if (running(child)) { child.kill('SIGKILL'); await Promise.race([stopped, sleep(2000)]) }
  if (running(child)) throw new Error('Packaged app did not exit')
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
  const port = await freePort()
  await launch(port)
  const setup = await evaluate(cdp, `(async () => {const setup=await window.electronAPI.setStore('setupComplete',true),language=await window.electronAPI.setStore('language','en');return {setup,language,setupRead:await window.electronAPI.getStore('setupComplete'),languageRead:await window.electronAPI.getStore('language')}})()`)
  if (!setup?.setup || !setup?.language || setup.setupRead !== true || setup.languageRead !== 'en') throw new Error('Could not persist isolated first-run preferences')
  const seed = await evaluate(cdp, `(async () => {
    const windowRange={start:'2026-01-01',end:'2026-01-02'};
    const snapshot={kind:'reading-snapshot',version:1,rangeLabel:'Synthetic range',window:windowRange,capturedAt:1000,accounts:[{platform:'tiktok',accountId:'SYNTHETIC_ID',name:'Synthetic account',status:'ok',statusDetail:null,window:windowRange,previousWindow:null,sourceAt:900,timezone:'UTC',currency:'USD',spend:42,previousSpend:null,impressions:100,clicks:3,conversions:1}]};
    const board=await window.electronAPI.saveReadingSnapshot({name:'Synthetic package board',snapshot,includeChart:true,language:'en'});
    if(!board.ok) return {stage:'snapshot',error:board.error};
    const widgetId=board.board.widgets[0].id, boardId=board.board.id;
    const opened=await window.electronAPI.loadOrCreateHtmlBoard({boardId,widgetId,language:'en'});
    if(!opened.ok) return {stage:'open',error:opened.error};
    const saved=await window.electronAPI.saveHtmlBoard({id:opened.document.id,expectedRevision:opened.document.revision,html:'<h1>Packaged smoke layout</h1><div data-reading-slot></div>',css:'h1 { color: #123456; }',theme:'minimal'});
    if(!saved.ok) return {stage:'save',error:saved.error};
    const found=await window.electronAPI.findHtmlBoardForReading({boardId,widgetId});
    const all=await window.electronAPI.listBoards();
    return {ok:found.ok && found.document.revision===saved.document.revision && found.document.html===saved.document.html && all.some(b=>b.id===boardId),boardId,widgetId};
  })()`)
  if (!seed?.ok) throw new Error(`Packaged persistence failed at ${seed?.stage ?? 'read-back'}`)
  // Restart the actual packaged process and verify the saved data again.
  cdp.close(); cdp = null
  await stopChild()
  await launch(port)
  const reopened = await evaluate(cdp, `(async () => {const r=await window.electronAPI.findHtmlBoardForReading({boardId:${JSON.stringify(seed.boardId)},widgetId:${JSON.stringify(seed.widgetId)}});return await window.electronAPI.getStore('setupComplete')===true && await window.electronAPI.getStore('language')==='en' && r.ok&&r.document.html.includes('Packaged smoke layout')})()`)
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
  console.log('Packaged app smoke passed: private profile, snapshot persistence, saved HTML, and source navigation.')
}
let timer
Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged smoke exceeded 90 seconds')), 90_000) })]).catch(error => { process.exitCode = 1; console.error(`Packaged app smoke failed: ${error.message}`); if (output) console.error(output) }).finally(async () => {
  clearTimeout(timer)
  try { cdp?.close() } catch { /* already closed */ }
  try { await stopChild() } catch (error) { process.exitCode = 1; console.error(error.message) }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
})
