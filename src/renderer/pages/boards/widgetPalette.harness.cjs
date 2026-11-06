const { app, BrowserWindow } = require('electron')
const path = require('node:path'), fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    win = new BrowserWindow({ show: true, width: 1200, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    await win.loadFile(path.join(dir, 'index.html'))
    const wc = win.webContents, wait = () => new Promise(resolve => setTimeout(resolve, 150))
    const read = () => wc.executeJavaScript(`Object.fromEntries([...document.querySelectorAll('[data-palette]')].map(section=>[section.dataset.palette,Object.fromEntries([...section.querySelectorAll('[data-kind]')].map(card=>{
      const css=getComputedStyle(card), find=(selector,key)=>{const node=card.querySelector(selector);return node?getComputedStyle(node)[key]:null};
      return [card.dataset.kind,{background:css.backgroundColor,text:find('.text-cream','color'),dim:find('.text-cream-dim','color'),faint:find('.text-cream-faint','color'),header:find('thead','backgroundColor'),cell:find('td','color'),rowBorder:find('tbody tr','borderBottomColor'),bar:find('li .bg-accent\\\\/50','backgroundColor'),status:find('[data-status]','color')}]
    }))]))`)
    await wait()
    const light = await read()
    await wc.executeJavaScript(`document.documentElement.classList.add('dark')`); await wait()
    const dark = await read()
    console.log('E2E_RESULT ' + JSON.stringify({ light, dark }))
  } catch (error) { console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error), stack: error.stack })) }
  finally { win?.destroy(); app.quit() }
})
