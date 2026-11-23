const { app, BrowserWindow } = require('electron')
const path = require('node:path'), fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: true, focusable: process.env.TOUSHOU_E2E_UNFOCUSED !== '1', width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    await win.loadFile(path.join(dir, 'index.html'))
    const wc = win.webContents, wait = () => new Promise(resolve => setTimeout(resolve, 150))
    const read = () => wc.executeJavaScript(`({count:document.querySelectorAll('section[aria-label="Board result"]').length,text:document.querySelector('section[aria-label="Board result"]')?.innerText,iframes:document.querySelectorAll('iframe').length,listCalls:window.deliveryFixture.listCalls,checks:window.deliveryFixture.checks})`)
    await wait()
    const unavailable = await read()
    await wc.executeJavaScript(`document.getElementById('restore').click()`); await wait()
    const ready = await read()
    await wc.executeJavaScript(`document.querySelector('section[aria-label="Board result"] button').click()`); await wait()
    const route = await wc.executeJavaScript(`document.getElementById('route').innerText`)
    await wc.executeJavaScript(`document.getElementById('edit').click()`); await wait()
    const multi = await wc.executeJavaScript(`Array.from(document.querySelectorAll('section[aria-label="Board result"]'), area => area.innerText)`)
    await wc.executeJavaScript(`Array.from(document.querySelectorAll('section[aria-label="Board result"]')).at(-1).querySelectorAll('button')[1].click()`)
    const draft = await wc.executeJavaScript(`({text:window.deliveryFixture.state.getState().composerPrefill, autosend:window.deliveryFixture.state.getState().composerAutosend})`)
    await wc.executeJavaScript(`Array.from(document.querySelectorAll('section[aria-label="Board result"]')).at(-1).querySelector('button').click()`); await wait()
    const emptyRoute = await wc.executeJavaScript(`document.getElementById('route').innerText`)
    const openPicker = () => wc.executeJavaScript(`document.getElementById('choose').focus(); document.getElementById('choose').click()`)
    const inspectPicker = () => wc.executeJavaScript(`(() => {
      const dialog = document.querySelector('[role=dialog]');
      const inputs = [...dialog.querySelectorAll('input[type=checkbox]')];
      return {
        checked: inputs.filter(input => input.checked).length,
        locked: inputs[2].disabled,
        focused: document.activeElement === inputs[0],
        confirm: [...dialog.querySelectorAll('button')].at(-1).disabled
      };
    })()`)
    await openPicker(); await wait()
    const picker = await inspectPicker()
    await wc.executeJavaScript(`for (const input of document.querySelectorAll('[role=dialog] input[type=checkbox]')) input.click()`)
    await wait()
    const checked = await inspectPicker()
    await wc.executeJavaScript(`[...document.querySelectorAll('[role=dialog] button')].at(-1).click()`); await wait()
    await openPicker(); await wait()
    const reopened = await inspectPicker()
    await wc.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait()
    const answers = await wc.executeJavaScript(`({answers: window.deliveryFixture.answers, open: !!document.querySelector('[role=dialog]'), focus: document.activeElement.id})`)
    console.log('E2E_RESULT ' + JSON.stringify({ unavailable, ready, route, multi, draft, emptyRoute, picker, checked, reopened, answers }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), stack: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
