const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
fs.mkdirSync(path.join(dir, 'profile'), { recursive: true, mode: 0o700 })
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    await win.loadFile(path.join(dir, 'index.html'))
    const data = await win.webContents.executeJavaScript('window.runProductTest()')
    console.log('E2E_RESULT ' + JSON.stringify(data))
  } catch (e) {
    console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(e) }))
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(0)
  }
})
