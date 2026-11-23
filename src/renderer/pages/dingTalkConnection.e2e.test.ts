import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

describe('DingTalk connection in Electron', () => {
  it('shows the official logo under Feishu and handles failed setup, private pairing, reconnect and disconnect', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dingtalk-ui-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      let esbuild: { buildSync: (options: Record<string, unknown>) => unknown }
      try { esbuild = require_('esbuild') } catch { esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      esbuild.buildSync({
        stdin: { contents: fixture, resolveDir: __dirname, sourcefile: 'dingtalk-fixture.tsx', loader: 'tsx' },
        outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
        alias: { '@shared': path.resolve(__dirname, '../../shared') }, loader: { '.svg': 'dataurl', '.png': 'dataurl' }
      })
      const harness = path.join(dir, 'harness.cjs')
      writeFileSync(harness, harnessSource)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [harness, dir], { encoding: 'utf8', timeout: 45_000, env })
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      expect(JSON.parse(line!.slice('E2E_RESULT '.length)), result.stdout).toEqual({
        officialAssetAndPlacement: true, guideAndConsole: true, passwordMasked: true, failure: true,
        storageRecovery: true, privatePairing: true, reconnect: true, disconnect: true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const fixture = `
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ConnectionsPage from './ConnectionsPage'
import { useAppStore } from '../store'

const disconnected = { status: 'disconnected', connected: false }
const idle = { ...disconnected, state: 'idle', configured: false, paired: false }
const awaitingPair = { status: 'waiting_for_user', state: 'connected', configured: true, paired: false, pairingCode: 'SYNTHETIC123' }
const paired = { ...awaitingPair, status: 'connected', paired: true, pairingCode: undefined }
const listeners = new Set()
const publish = (snapshot) => { for (const listener of listeners) listener(snapshot); return snapshot }
let blocked = false
const harness = window.dingFixture = {
  connected: false, opened: [],
  blockPairing: () => {
    blocked = true
    publish({ ...awaitingPair, lastError: 'storage-unavailable' })
  },
  pair: () => publish(paired),
  drop: () => publish({ ...paired, status: 'degraded', state: 'reconnecting', lastError: 'network' })
}
const ignoreEvents = () => () => {}
window.electronAPI = {
  dingTalkStatus: async () => idle,
  onDingTalkStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  dingTalkOpenSetup: async () => { harness.opened.push('console'); return true },
  dingTalkOpenGuide: async () => { harness.opened.push('guide'); return true },
  dingTalkConnect: async ({ clientId, clientSecret }) => {
    if (clientId !== 'fixture-app' || clientSecret !== 'correct-fixture-secret') {
      return { ok: false, error: 'invalid-credentials', snapshot: publish({ ...idle, state: 'error', status: 'failed', lastError: 'invalid-credentials' }) }
    }
    harness.connected = true
    return { ok: true, snapshot: publish(awaitingPair) }
  },
  dingTalkReconnect: async () => {
    const snapshot = publish(blocked ? awaitingPair : paired)
    blocked = false
    return { ok: true, snapshot }
  },
  dingTalkDisconnect: async () => ({ ok: true, snapshot: publish(idle) }),
  feishuStatus: async () => ({ ...disconnected, state: 'idle', authorizedCapabilities: ['messaging'] }),
  onFeishuStatus: ignoreEvents,
  tiktokStatus: async () => disconnected, onTiktokStatus: ignoreEvents,
  ttReadingAdvertisers: async () => ({ selected: [], granted: [] }),
  metaAdsStatus: async () => disconnected, onMetaAdsStatus: ignoreEvents,
  appsflyerStatus: async () => disconnected, onAppsFlyerStatus: ignoreEvents,
  figmaStatus: async () => disconnected, onFigmaStatus: ignoreEvents,
  mcpList: async () => [], adsCopyModelsList: async () => ({ mode: 'chat', providers: [] })
}
useAppStore.setState({ language: 'zh' })
createRoot(document.getElementById('root')).render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
`

const harnessSource = `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = win.webContents
    wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }))
    await win.loadFile(path.join(dir, 'index.html'))
    const js = (source) => wc.executeJavaScript('(() => { const card = document.querySelector("section[aria-labelledby=dingtalk-connection-heading]"); return (' + source + '); })()')
    const wait = async (expression) => {
      const deadline = Date.now() + 5_000
      while (!await js(expression)) {
        if (Date.now() > deadline) throw new Error('Timed out: ' + expression)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    const click = (label) => js('[...card.querySelectorAll("button")].find((button) => button.textContent.trim() === ' + JSON.stringify(label) + ').click()')
    const fill = (selector, value) => js('(() => { const input = card.querySelector(' + JSON.stringify(selector) + '); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ' + JSON.stringify(value) + '); input.dispatchEvent(new Event("input", { bubbles: true })); })()')

    await wait('card?.textContent.includes("未连接") && card.querySelector("img").naturalWidth === 444')
    const officialAssetAndPlacement = await js('card.previousElementSibling.querySelector("h2").textContent === "飞书" && card.querySelector("h2").textContent === "钉钉" && card.querySelector("img").src.startsWith("data:image/png")')
    await click('连接钉钉')
    await wait('!!card.querySelector("form")')
    const passwordMasked = await js('card.querySelectorAll("input")[1].type === "password" && card.querySelector("button[type=submit]").disabled')
    await click('打开开发者后台')
    await click('官方接入指南')
    const guideAndConsole = await js('window.dingFixture.opened.join(",") === "console,guide"')
    await fill('input[type=text]', 'fixture-app')
    await fill('input[type=password]', 'wrong-fixture-secret')
    await click('验证并连接')
    await wait('card.querySelector("[role=alert]")?.textContent.includes("拒绝了应用凭证")')
    const failure = await js('card.textContent.includes("连接失败") && card.querySelector("input[type=password]").value === "" && !card.textContent.includes("wrong-fixture-secret")')
    await fill('input[type=password]', 'correct-fixture-secret')
    await click('验证并连接')
    await wait('card.querySelector("code")?.textContent === "/pair SYNTHETIC123" && !card.querySelector("form")')
    const awaiting = await js('card.querySelector("[role=status]").textContent === "待绑定账号" && card.textContent.includes("单聊") && window.dingFixture.connected')
    await js('(window.dingFixture.blockPairing(), null)')
    await wait('card.querySelector("[role=alert]")?.textContent.includes("安全存储暂不可用")')
    await click('重试安全存储')
    await wait('card.querySelector("code")?.textContent === "/pair SYNTHETIC123" && !card.querySelector("[role=alert]")')
    await js('(window.dingFixture.pair(), null)')
    await wait('card.querySelector("[role=status]").textContent === "已连接"')
    const privatePairing = awaiting && await js('!card.querySelector("code") && card.textContent.includes("账号已绑定") && card.textContent.includes("/ping")')
    await js('(window.dingFixture.drop(), null)')
    await wait('card.querySelector("[role=status]").textContent.includes("正在重连钉钉")')
    await click('重新连接')
    await wait('card.querySelector("[role=status]").textContent === "已连接" && !card.querySelector("[role=alert]")')
    await click('断开连接')
    await wait('card.querySelector("[role=status]").textContent === "未连接" && card.textContent.includes("连接钉钉")')
    const disconnect = await js('!card.querySelector("code") && !card.textContent.includes("账号已绑定")')
    console.log('E2E_RESULT ' + JSON.stringify({ officialAssetAndPlacement, guideAndConsole, passwordMasked, failure, storageRecovery: true, privatePairing, reconnect: true, disconnect }))
  } catch (error) {
    console.log('E2E_RESULT ' + JSON.stringify({ fatal: String(error) }))
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.quit()
  }
})
`
