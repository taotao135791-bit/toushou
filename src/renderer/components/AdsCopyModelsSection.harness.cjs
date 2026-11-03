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
    // This fixture can never contact a live provider or load user credentials.
    wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    await win.loadFile(html)
    const js = source => wc.executeJavaScript(source)
    const waitFor = async expression => {
      const deadline = Date.now() + 10000
      while (!await js(expression)) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`)
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    const edit = async (placeholder, value) => {
      await js(`(() => { const e=document.querySelector('[placeholder=${JSON.stringify(placeholder)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await waitFor(`document.querySelector('[placeholder=${JSON.stringify(placeholder)}]').value === ${JSON.stringify(value)}`)
    }
    const click = label => js(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})).click()`)
    const modelList = () => js(`[...document.querySelectorAll('#ads-copy-discovered-models option')].map(e=>e.value)`)
    const resolveDiscovery = async (index, models) => {
      await js(`window.adsCopyFixture.discoveries[${index}].resolve({ok:true,models:${JSON.stringify(models)}})`)
      await waitFor(`document.querySelectorAll('#ads-copy-discovered-models option').length===${models.length}`)
    }
    await waitFor(`!!document.querySelector('[placeholder="API key"]')`)
    await edit('API base URL (https://…)', 'https://relay-a.example.test/v1')
    await edit('API key', 'synthetic-key-a')
    await click('Sniff models')
    await waitFor('window.adsCopyFixture.discoveries.length===1')
    await edit('API base URL (https://…)', 'https://relay-b.example.test/v1')
    await waitFor(`![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Sniff models').disabled`)
    const afterAddressChange = await modelList()
    await click('Sniff models')
    await waitFor('window.adsCopyFixture.discoveries.length===2')
    await resolveDiscovery(1, ['B-model', 'b-model'])
    await js(`window.adsCopyFixture.discoveries[0].resolve({ok:true,models:['stale-A-model']})`)
    await new Promise(resolve => setTimeout(resolve, 50))
    const afterLateResponse = await modelList()

    await edit('API key', 'synthetic-key-b')
    await waitFor(`document.querySelectorAll('#ads-copy-discovered-models option').length===0`)
    const afterKeyChange = await modelList()
    await click('Sniff models')
    await waitFor('window.adsCopyFixture.discoveries.length===3')
    await resolveDiscovery(2, ['new-key-model'])
    await js(`(() => {const e=document.querySelector('select');e.value='anthropic';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await waitFor(`document.querySelectorAll('#ads-copy-discovered-models option').length===0`)
    const afterProtocolChange = await modelList()
    await click('Sniff models')
    await waitFor('window.adsCopyFixture.discoveries.length===4')
    await resolveDiscovery(3, ['anthropic-model'])

    await js(`window.adsCopyFixture.clipboard=JSON.stringify({baseUrl:'https://relay-c.example.test/v1',apiKey:'synthetic-key-c',protocol:'openai'})`)
    await js(`document.querySelector('[title="Paste relay connection info (JSON) to autofill"]').click()`)
    await waitFor(`document.querySelector('[placeholder="API base URL (https://…)"]').value==='https://relay-c.example.test/v1'`)
    const afterPaste = await modelList()
    await click('Sniff models')
    await waitFor('window.adsCopyFixture.discoveries.length===5')
    await resolveDiscovery(4, ['C-model', 'c-model'])
    await click('Select all')
    await waitFor(`document.querySelectorAll('label input:checked').length===2`)
    await click('Add selected')
    await click('Add selected')
    await waitFor('window.adsCopyFixture.saves.length===1')
    const whileSaving = await js(`({disabled:[...document.querySelectorAll('label input')].every(e=>e.disabled),saved:window.adsCopyFixture.saves[0].map(({model,baseUrl,protocol,apiKey})=>({model,baseUrl,protocol,keyMatches:apiKey==='synthetic-key-c'}))})`)
    await js('window.adsCopyFixture.finishSave(false)')
    await waitFor(`!!document.querySelector('[role="alert"]')`)
    const afterFailure = await js(`({selected:document.querySelectorAll('label input:checked').length,existing:document.body.textContent.includes('Existing model'),keyRetained:document.querySelector('[placeholder="API key"]').value==='synthetic-key-c'})`)
    await click('Add selected')
    await waitFor('window.adsCopyFixture.saves.length===2')
    await js('window.adsCopyFixture.finishSave(true)')
    await waitFor(`document.body.textContent.includes('Added 2, skipped 0')`)
    const afterSuccess = await js(`({selected:document.querySelectorAll('label input:checked').length,models:window.adsCopyFixture.rows.map(row=>row.model)})`)
    console.log('E2E_RESULT ' + JSON.stringify({ afterAddressChange, afterLateResponse, afterKeyChange, afterProtocolChange, afterPaste, whileSaving, afterFailure, afterSuccess }))
  } catch (error) {
    console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error) }))
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.quit()
  }
})
