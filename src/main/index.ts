import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { readdirSync, unlinkSync } from 'node:fs'
import { getStore, setStore, applyFirstRunDefaults } from './store'
import { registerIpc } from './ipc'
import { syncMachineSkills } from './piSettings'
import { detectCli } from './omp'
import { initUpdater } from './updater'
import { installNavigationGuards } from './navigation'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

/**
 * Approval configs are per-session files; sessions never outlive the app,
 * so anything left in userData at startup is an orphan from a crashed or
 * force-killed run. Safe to sweep before the first session spawns.
 */
function cleanStaleApprovalConfigs() {
  try {
    const dir = app.getPath('userData')
    for (const name of readdirSync(dir)) {
      if (name.startsWith('omp-approval-config-') && name.endsWith('.json')) {
        unlinkSync(path.join(dir, name))
      }
    }
  } catch {
    // userData missing or unreadable — nothing to clean
  }
}

function createWindow() {
  // Clamp persisted sizes in case the store holds corrupt values
  const width = Math.max(900, Math.min(getStore('windowWidth') || 1280, 5120))
  const height = Math.max(600, Math.min(getStore('windowHeight') || 800, 5120))

  const rendererEntryPath = path.join(__dirname, '../renderer/index.html')
  const devServerUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  installNavigationGuards(
    win.webContents,
    { rendererEntryPath, devServerUrl },
    (url) => shell.openExternal(url)
  )

  // 'resize' fires on all platforms; 'resized' is Windows-only
  win.on('resize', () => {
    const [w, h] = win.getSize()
    setStore('windowWidth', w)
    setStore('windowHeight', h)
  })

  if (devServerUrl) {
    win.loadURL(devServerUrl)
    win.webContents.openDevTools()
  } else {
    win.loadFile(rendererEntryPath)
  }

  return win
}

app.whenReady().then(() => {
  registerIpc()
  applyFirstRunDefaults()
  // Keep pi's skill overrides in line with the GUI toggle — LEGACY pi loads
  // ~/.agents/skills (other agents' skills) into every session by default.
  // Current Oh My Pi manages this through its own config
  // (skills.enableAgentsUser via the runtime settings adapter), so the
  // legacy settings.json sync must not run there.
  if (detectCli().command !== 'omp') {
    syncMachineSkills(getStore('machineSkills'))
  }
  cleanStaleApprovalConfigs()
  createWindow()
  initUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
