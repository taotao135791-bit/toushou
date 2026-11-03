const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    const html = path.join(dir, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: false, width: 1024, height: 700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    wc.on('console-message', (_event, _level, message) => console.log('RENDERER ' + message))
    wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    await win.loadFile(html)
    const js = async source => {
      try { return await wc.executeJavaScript(source) }
      catch (error) { throw new Error(`${source}: ${String(error)}`) }
    }
    const waitFor = async expression => {
      const until = Date.now() + 5000
      while (!await js(expression)) {
        if (Date.now() > until) throw new Error(`Timed out: ${expression}`)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    const emit = async status => { await js(`window.updateFixture.emit(${JSON.stringify(status)})`); await new Promise(resolve => setTimeout(resolve, 20)) }
    const text = () => js(`document.querySelector('#banner').textContent`)
    await waitFor('!!window.updateFixture?.listener && !!window.updateFixture?.initial')
    const quiet = []
    for (const status of [{ status: 'checking' }, { status: 'none' }, { status: 'error', message: 'Synthetic network error', operation: 'check' }]) {
      await emit(status)
      quiet.push(await text())
    }
    await emit({ status: 'available', version: '2.1.0' })
    await js(`window.updateFixture.initial({status:'idle'})`)
    await waitFor(`document.querySelector('#banner').textContent.includes('2.1.0')`)
    const afterLateSnapshot = await text()
    const downloadsBeforeClick = await js('window.updateFixture.downloads')
    await js(`document.querySelector('[aria-label="Dismiss"]').click()`)
    await waitFor(`document.querySelector('#banner').textContent===''`)
    await emit({ status: 'available', version: '2.1.0' })
    const dismissedSameVersion = await text()
    await emit({ status: 'available', version: '2.2.0' })
    await waitFor(`document.querySelector('#banner').textContent.includes('2.2.0')`)
    await js(`[...document.querySelectorAll('#banner button')].find(e=>e.textContent==='Update now').click()`)
    await waitFor('window.updateFixture.downloads===1')
    await emit({ status: 'progress', percent: 42.4 })
    const progress = await text()
    await emit({ status: 'downloaded', version: '2.2.0' })
    const ready = await text()
    const installsBeforeClick = await js('window.updateFixture.installs')
    await js(`[...document.querySelectorAll('#banner button')].find(e=>e.textContent==='Restart & update').click()`)
    const installsAfterClick = await js('window.updateFixture.installs')
    await emit({ status: 'error', message: 'Synthetic download error', operation: 'download' })
    const downloadError = await text()
    await emit({ status: 'available', version: '2.3.0' })
    await js(`document.querySelector('#remount').click()`)
    await waitFor('window.updateFixture.snapshots===2')
    await waitFor(`document.querySelector('#banner').textContent.includes('2.3.0')`)
    const remounted = await text()
    console.log('E2E_RESULT ' + JSON.stringify({ quiet, afterLateSnapshot, downloadsBeforeClick, dismissedSameVersion, progress, ready, installsBeforeClick, installsAfterClick, downloadError, remounted }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error) })); process.exitCode = 1 }
  finally { win?.destroy(); app.quit() }
})
