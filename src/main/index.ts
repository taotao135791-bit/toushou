import { app, BrowserWindow, shell, type IpcMainEvent } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import path from 'node:path'
import { readdirSync, unlinkSync } from 'node:fs'
import { getStore, setStore, applyFirstRunDefaults } from './store'
import { ensureBundledPackages } from './bundledPackages'
import { initBrowserUseBridge } from './browserUse'
import { initializeAppsFlyerToolBridge, ensureAppsFlyerFreshToken } from './appsflyerConnection'
import { registerIpc, shutdownSessionsForQuit, tiktokAdsConnectionManager } from './ipc'
import { pruneOrphanedHtmlBoards } from './htmlBoards'
import { cancelOwnerHtmlBoardAiEdits } from './htmlBoardAi'
import { syncMachineSkills } from './piSettings'
import { detectCli, getSession } from './omp'
import { initUpdater } from './updater'
import { initSessionTopicBridge } from './sessionTopicBridge'
import { installNavigationGuards } from './navigation'
import { initFeishuBridge } from './integrations/feishu/feishuBridge'
import { initDingTalkBridge } from './dingTalkBridge'
import { initTasksBridge } from './tasksBridge'
import { initTiktokBridge } from './tiktokBridge'
import { initBoardsBridge } from './boardsBridge'
import { initMemoryBridge } from './memoryBridge'
import { initAdsCopyBridge } from './adsCopyBridge'
import { ensureKernelSkill } from './kernelSkill'
import { feishuConnectionManager } from './integrations/feishu/FeishuConnectionManager'
import { dingTalkConnectionManager } from './integrations/dingtalk/DingTalkConnectionManager'
import { tiktokReportService } from './integrations/tiktok/TikTokRefreshService'
import { tokenKeepAlive } from './tokenKeepAlive'
import { installFileLogging } from './lib/logger'
import { applyWindowTheme, themeBackgroundColor } from './windowTheme'

// File logging must be the first thing main does: it captures the console
// output of the startup sequence below into userData/logs/main.log.
installFileLogging()

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Windows notifications (completion/approval toasts) are attributed through
// the App User Model ID; without it packaged toasts can fail to appear.
if (process.platform === 'win32') {
  app.setAppUserModelId(process.env.TOUSHOU_RELEASE_CHANNEL === 'beta' ? 'com.toushou.desktop.beta' : 'com.toushou.app')
}

// Multiple app copies otherwise compete for the same userData, native browser
// view, and session state. Keep one owner and focus it when the launcher is
// opened again.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.moveTop()
    win.focus()
    // Windows foreground lock: a background process may not steal focus, so
    // show()/focus() from the deferring launcher can end up as a taskbar
    // flash the user never notices — the app then looks like it "won't
    // open". Briefly raising always-on-top forces the existing window
    // above every stack, then releases the flag.
    if (process.platform === 'win32') {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setAlwaysOnTop(false)
    }
  })
}

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

const draftCloseReady = new WeakSet<BrowserWindow>()
const draftAwareWindows = new WeakSet<BrowserWindow>()
const draftFlushRequests = new WeakMap<BrowserWindow, Promise<void>>()
let draftFlushRequestId = 0
let quitDraftFlushPending = false
let quitDraftFlushReady = false

function flushWindowComposerDrafts(win: BrowserWindow): Promise<void> {
  const pending = draftFlushRequests.get(win)
  if (pending) return pending
  const contents = win.webContents
  if (contents.isDestroyed() || contents.isLoadingMainFrame()) return Promise.resolve()
  const ipc = contents.ipc
  const requestId = ++draftFlushRequestId
  const result = new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(deadline)
      ipc.removeListener(IPC_CHANNELS.COMPOSER_DRAFTS_FLUSHED, onFlushed)
      contents.removeListener('destroyed', finish)
      resolve()
    }
    const onFlushed = (event: IpcMainEvent, id: unknown) => {
      if (event.senderFrame === contents.mainFrame && id === requestId) finish()
    }
    const deadline = setTimeout(finish, 1500)
    ipc.on(IPC_CHANNELS.COMPOSER_DRAFTS_FLUSHED, onFlushed)
    contents.once('destroyed', finish)
    try { contents.send(IPC_CHANNELS.COMPOSER_DRAFTS_FLUSH_REQUEST, requestId) } catch { finish() }
  }).finally(() => draftFlushRequests.delete(win))
  draftFlushRequests.set(win, result)
  return result
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
    // Slightly inset the native macOS controls within the 44px drag area.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 14 } } : {}),
    backgroundColor: themeBackgroundColor(getStore('theme') ?? 'light'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  draftAwareWindows.add(win)

  installNavigationGuards(
    win.webContents,
    { rendererEntryPath, devServerUrl },
    (url) => shell.openExternal(url)
  )

  win.on('close', (event) => {
    if (draftCloseReady.delete(win)) return
    event.preventDefault()
    void flushWindowComposerDrafts(win).then(() => {
      if (win.isDestroyed() || quitDraftFlushPending) return
      draftCloseReady.add(win)
      win.close()
    })
  })

  // 'resize' fires on all platforms; 'resized' is Windows-only
  win.on('resize', () => {
    const [w, h] = win.getSize()
    setStore('windowWidth', w)
    setStore('windowHeight', h)
  })

  if (devServerUrl) {
    win.loadURL(devServerUrl)
    // DevTools stay closed on launch; open manually (View → Toggle Developer
    // Tools / Ctrl+Shift+I) or opt back in with TOUSHOU_DEVTOOLS=1.
    if (process.env.TOUSHOU_DEVTOOLS === '1') {
      win.webContents.openDevTools()
    }
  } else {
    win.loadFile(rendererEntryPath)
  }

  return win
}

app.whenReady().then(async () => {
  console.info(`[app] starting TouShou ${app.getVersion()} (${process.platform}, electron ${process.versions.electron})`)
  try {
    if (!pruneOrphanedHtmlBoards().ok) console.warn('[boards] HTML cleanup needs retry from the boards page')
  } catch { console.warn('[boards] HTML cleanup deferred until local storage is readable') }
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
  // Loopback bridge for the bundled browser-use tools; started before the
  // first session spawn so its env is available from session one. Awaiting
  // listen avoids a startup race where the first OMP process receives an
  // empty TOUSHOU_BROWSER_USE value.
  try {
    await initBrowserUseBridge()
  } catch (error) {
    console.warn('[browser-use] bridge unavailable', error)
  }
  try {
    await initFeishuBridge()
  } catch (error) {
    console.warn('[feishu] tool bridge unavailable', error)
  }
  try {
    await initDingTalkBridge()
  } catch {
    console.warn('[dingtalk] tool bridge unavailable')
  }
  // Only the local listener is awaited. Slow authorization restoration stays
  // in the background; first-session reads wait for it at the trusted bridge.
  await initializeAppsFlyerToolBridge()
  try {
    await initTasksBridge()
    await initTiktokBridge()
    await initBoardsBridge()
    await initAdsCopyBridge()
    // 记忆桥：会话 identity 由 omp 注册表按 id 提供（cwd 决定项目隔离）。
    await initMemoryBridge((sessionId) => {
      const session = getSession(sessionId)
      return session ? { id: session.id, cwd: session.cwd, title: session.title } : undefined
    })
  } catch (error) {
    console.warn('[tasks] tool bridge unavailable', error)
  }
  try {
    await initSessionTopicBridge()
  } catch {
    // Metadata naming is independent of advertising tools and never blocks startup.
    console.warn('[session-topic] automatic topic bridge unavailable')
  }
  // The viral-competitive-analysis chain is product kernel: its playbook
  // skill must exist in every install (idempotent, version-upgrading).
  const kernelSkill = ensureKernelSkill()
  if (!kernelSkill.ok) console.warn('[kernel-skill] install failed:', kernelSkill.error)
  // A runtime loads package extensions when the session process starts. Finish
  // relinking this app's bundled resources before IPC starts the scheduler or
  // exposes session creation to the first window (including cold CLI starts).
  try {
    const preparation = await ensureBundledPackages()
    if (!preparation.ok) console.warn('[bundled-packages] startup preparation incomplete', preparation.failed)
  } catch (error) {
    console.warn('[bundled-packages] startup preparation failed', error)
  }
  applyWindowTheme(getStore('theme'))
  registerIpc()
  createWindow()
  initUpdater()
  // Background-only recovery: GUI creation is never held up by Feishu DNS or
  // WebSocket handshake latency.
  void feishuConnectionManager.initialize()
  void dingTalkConnectionManager.initialize()
  // TikTok 报表自动刷新：仅在持久化开关为开时启动 30 分钟定时器。
  tiktokReportService.restoreFromSettings()
  // MCP 令牌后台续签：在令牌到期前主动刷新 TikTok / AppsFlyer 的 OAuth
  // 授权，避免闲置后首次读数才发现令牌过期（详见 tokenKeepAlive.ts）。
  tokenKeepAlive.registerTarget('tiktok-ads', () => tiktokAdsConnectionManager.keepAliveToken())
  tokenKeepAlive.registerTarget('appsflyer', () => ensureAppsFlyerFreshToken())
  tokenKeepAlive.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// No OMP child should outlive the GUI — a remote or task turn running on
// after quit keeps consuming provider quota with nobody watching.
app.on('before-quit', (event) => {
  const windows = BrowserWindow.getAllWindows()
  const draftWindows = windows.filter((win) => draftAwareWindows.has(win))
  if (!quitDraftFlushReady && draftWindows.length) {
    event.preventDefault()
    if (quitDraftFlushPending) return
    quitDraftFlushPending = true
    void Promise.all(draftWindows.map(flushWindowComposerDrafts)).then(() => {
      quitDraftFlushPending = false
      quitDraftFlushReady = true
      for (const win of draftWindows) draftCloseReady.add(win)
      app.quit()
    })
    return
  }
  quitDraftFlushReady = false
  dingTalkConnectionManager.shutdown()
  for (const window of windows) cancelOwnerHtmlBoardAiEdits(window.webContents.id)
  shutdownSessionsForQuit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
