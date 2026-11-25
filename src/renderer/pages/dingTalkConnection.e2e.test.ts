import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

describe('DingTalk connection in Electron', () => {
  it('signs in to DingTalk from one button and handles cancellation, organization access, verification and disconnect', { timeout: 60_000 }, () => {
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
      expect(result.status, result.error?.message || result.stderr).toBe(0)
      expect(JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8'))).toEqual({
        officialAssetAndPlacement: true, signInScope: true, oneClick: true, cancelled: true, organizationAccess: true,
        connected: true, check: true, disconnect: true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
})

const fixture = `
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ConnectionsPage from './ConnectionsPage'
import { useAppStore } from '../store'

const disconnected = { status: 'disconnected', connected: false }
const idle = { ...disconnected, state: 'idle', configured: false, cliInstalled: false }
const installed = { ...idle, cliInstalled: true }
const installing = { ...idle, state: 'installing', status: 'connecting' }
const authorizing = { ...installed, state: 'authorizing', status: 'waiting_for_user' }
const connected = { ...installed, state: 'connected', status: 'connected', configured: true, accountName: '测试账号', organizationName: '测试组织' }
const accessRequired = { ...installed, state: 'error', status: 'needs_attention', lastError: 'organization-access-required' }
const listeners = new Set()
const publish = (snapshot) => { for (const listener of listeners) listener(snapshot); return snapshot }
let cliInstalled = false
let login = null
const fixture = window.dingFixture = {
  calls: [],
  beginBrowser: () => {
    cliInstalled = true
    fixture.calls.push('browser')
    publish(authorizing)
  },
  completeLogin: (outcome) => {
    const snapshot = outcome === 'connected' ? connected : accessRequired
    login({ ok: outcome === 'connected', snapshot: publish(snapshot) })
    login = null
  },
  completeCancelledLogin: () => {
    login({ ok: false, error: 'authorization-failed', snapshot: { ...installed, state: 'error' } })
    login = null
  }
}
const ignoreEvents = () => () => {}
window.electronAPI = {
  dingTalkStatus: async () => idle,
  onDingTalkStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  dingTalkOpenGuide: async () => { fixture.calls.push('guide'); return true },
  dingTalkConnect: (...args) => {
    if (args.length) throw new Error('DingTalk sign-in takes no credentials')
    fixture.calls.push('sign-in')
    if (cliInstalled) fixture.beginBrowser()
    else publish(installing)
    return new Promise(resolve => { login = resolve })
  },
  dingTalkCancel: async () => {
    fixture.calls.push('cancel')
    return { ok: true, snapshot: publish(installed) }
  },
  dingTalkReconnect: async () => {
    fixture.calls.push('check')
    publish({ ...connected, state: 'checking', status: 'connecting' })
    return { ok: true, snapshot: publish(connected) }
  },
  dingTalkDisconnect: async () => {
    fixture.calls.push('disconnect')
    return { ok: true, snapshot: publish(installed) }
  },
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

    await wait('card?.textContent.includes("未连接") && card.querySelector("img").naturalWidth === 444')
    const officialAssetAndPlacement = await js('card.previousElementSibling.querySelector("h2").textContent === "飞书" && card.querySelector("h2").textContent === "钉钉" && card.querySelector("img").src.startsWith("data:image/png")')
    const signInScope = await js('["聊天消息（只读）", "有写入权限", "创建在线文字文档", "追加正文"].every(text => card.textContent.includes(text))')
    await click('钉钉账号登录')
    await wait('card.querySelector("[role=status]").textContent.includes("正在安装钉钉 CLI")')
    await js('(window.dingFixture.beginBrowser(), null)')
    await wait('card.querySelector("[role=status]").textContent.includes("等待钉钉授权") && card.textContent.includes("在浏览器中完成")')
    const oneClick = await js('!card.querySelector("input, form, code") && window.dingFixture.calls.join(",") === "sign-in,browser"')

    await click('取消登录')
    await wait('card.querySelector("[role=status]").textContent === "未连接"')
    await js('(window.dingFixture.completeCancelledLogin(), null)')
    const cancelled = await js('window.dingFixture.calls.includes("cancel") && !card.querySelector("[role=alert]") && card.textContent.includes("钉钉账号登录")')

    await click('钉钉账号登录')
    await wait('card.querySelector("[role=status]").textContent.includes("等待钉钉授权")')
    await js('(window.dingFixture.completeLogin("accessRequired"), null)')
    await wait('card.querySelector("[role=alert]")?.textContent.includes("联系组织管理员开通") && card.textContent.includes("钉钉账号登录")')
    await click('钉钉官方帮助')
    const organizationAccess = await js('window.dingFixture.calls.includes("guide")')

    await click('钉钉账号登录')
    await wait('card.querySelector("[role=status]").textContent.includes("等待钉钉授权")')
    await js('(window.dingFixture.completeLogin("connected"), null)')
    await wait('card.querySelector("[role=status]").textContent === "已连接" && !card.querySelector("[role=alert]")')
    const connected = await js('["测试账号", "测试组织", "聊天消息（只读）", "阅读在线文档", "有权限的文件夹创建在线文字文档", "可编辑的文字文档追加正文"].every(text => card.textContent.includes(text))')
    await click('检查连接')
    await wait('card.querySelector("[role=status]").textContent === "已连接" && [...card.querySelectorAll("button")].some(button => button.textContent === "断开连接" && !button.disabled)')
    const check = await js('window.dingFixture.calls.includes("check")')
    await click('断开连接')
    await wait('card.querySelector("[role=status]").textContent === "未连接" && card.textContent.includes("钉钉账号登录")')
    const disconnect = await js('window.dingFixture.calls.includes("disconnect") && !card.textContent.includes("测试账号")')
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ officialAssetAndPlacement, signInScope, oneClick, cancelled, organizationAccess, connected, check, disconnect }))
  } catch (error) {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ fatal: String(error) }))
  } finally {
    win?.destroy()
    app.quit()
  }
})
`
