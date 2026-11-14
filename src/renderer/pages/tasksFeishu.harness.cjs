const { app, BrowserWindow } = require('electron')
const path = require('node:path'), fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: true, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    await win.loadFile(path.join(dir, 'index.html'))
    const until = async (expression, label) => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (await wc.executeJavaScript(expression).catch(() => false)) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(`Timed out waiting for ${label}`)
    }
    await until(`!!document.querySelector('header button')`, 'task page')
    await wc.executeJavaScript(`document.querySelector('header button').click()`)
    await until(`!!document.querySelector('fieldset textarea') && !!document.querySelector('fieldset input:not([type])')`, 'new task form')
    await wc.executeJavaScript(`(() => {
      const set = (element, value) => { const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', {bubbles:true})) }
      set(document.querySelector('fieldset input:not([type])'), 'New fixture')
      set(document.querySelector('fieldset textarea'), 'Synthetic task')
      const select = [...document.querySelectorAll('fieldset select')].find(e => [...e.options].some(o => o.value === 'feishu'))
      select.value = 'feishu'; select.dispatchEvent(new Event('change', {bubbles:true}))
    })()`)
    await until(`[...document.querySelectorAll('fieldset select')].some(e=>[...e.options].some(o=>o.value==='oc_named_synthetic_12345678'))`, 'recipient options')
    const initial = await wc.executeJavaScript(`(() => {const select=[...document.querySelectorAll('fieldset select')].find(e=>[...e.options].some(o=>o.value==='oc_named_synthetic_12345678')); const buttons=[...document.querySelectorAll('.dialog-backdrop button')];return {selected:select.value,options:[...select.options].map(o=>o.textContent),disabled:buttons.find(e=>e.textContent.trim()==='New task').disabled}})()`)
    await wc.executeJavaScript(`(() => {const e=[...document.querySelectorAll('fieldset select')].find(e=>[...e.options].some(o=>o.value==='oc_named_synthetic_12345678'));e.value='oc_named_synthetic_12345678';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await until(`!![...document.querySelectorAll('.dialog-backdrop button')].find(e=>e.textContent.trim()==='New task' && !e.disabled)`, 'new task enabled')
    await wc.executeJavaScript(`[...document.querySelectorAll('.dialog-backdrop button')].find(e=>e.textContent.trim()==='New task').click()`)
    await until(`window.taskFixture.saved.length===1 && !document.querySelector('.dialog-backdrop')`, 'new task saved')
    const created = await wc.executeJavaScript(`window.taskFixture.saved.at(-1)`)
    await wc.executeJavaScript(`(() => {const c=[...document.querySelectorAll('.rounded-xl.border')].find(e=>e.textContent.includes('Legacy fixture'));c.querySelector('button[title="Edit"]').click()})()`)
    await until(`[...document.querySelectorAll('fieldset select')].some(e=>[...e.options].some(o=>o.value==='oc_named_synthetic_12345678')) && !![...document.querySelectorAll('.dialog-backdrop button')].find(e=>e.textContent.trim()==='Save')`, 'legacy task form')
    const legacy = await wc.executeJavaScript(`(() => {const s=[...document.querySelectorAll('fieldset select')].find(e=>[...e.options].some(o=>o.value==='oc_named_synthetic_12345678'));return {selected:s.value,disabled:[...document.querySelectorAll('.dialog-backdrop button')].find(e=>e.textContent.trim()==='Save').disabled}})()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('.dialog-backdrop button')].find(e=>e.textContent.trim()==='Save').click()`)
    await until(`window.taskFixture.saved.length===2 && !document.querySelector('.dialog-backdrop')`, 'legacy task saved')
    const legacySaved = await wc.executeJavaScript(`window.taskFixture.saved.at(-1)`)
    await wc.executeJavaScript(`(() => {const c=[...document.querySelectorAll('.rounded-xl.border')].find(e=>e.textContent.includes('Delivery fixture'));[...c.querySelectorAll('button')].find(e=>e.textContent.includes('Run history')).click()})()`)
    await until(`document.body.innerText.includes('Delivery unknown') && !![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Retry delivery')`, 'delivery history')
    const history = await wc.executeJavaScript(`(() => {const c=[...document.querySelectorAll('.rounded-xl.border')].find(e=>e.textContent.includes('Delivery fixture'));const unknown=[...c.querySelectorAll('span')].find(e=>e.textContent.includes('Delivery unknown'));const failed=[...c.querySelectorAll('span')].find(e=>e.textContent.includes('Not sent to Feishu'));return {unknown:unknown?.parentElement.innerText,unknownRetry:!!unknown?.parentElement.querySelector('button'),failed:failed?.parentElement.innerText,failedRetry:!!failed?.parentElement.querySelector('button')}})()`)
    await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Retry delivery').click()`)
    await until(`window.taskFixture.retries.length===1`, 'delivery retry')
    const retries = await wc.executeJavaScript(`window.taskFixture.retries`)
    console.log('E2E_RESULT ' + JSON.stringify({ initial, created, legacy, legacySaved, history, retries }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), stack: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
