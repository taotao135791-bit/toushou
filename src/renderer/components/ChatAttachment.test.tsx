import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

it('opens, reveals and saves attachments separately and opens explicit directories in their own right', { timeout: 45_000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attachment-actions-'))
  try {
    const electronRoot = path.dirname(require_.resolve('electron/package.json'))
    const executable = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron'
    const esbuild = createRequire(require_.resolve('vite/package.json'))('esbuild')
    esbuild.buildSync({
      stdin: { contents: fixture, resolveDir: __dirname, sourcefile: 'attachment-actions.tsx', loader: 'tsx' },
      bundle: true, platform: 'browser', jsx: 'automatic', loader: { '.svg': 'dataurl' },
      alias: { '@shared': path.resolve(__dirname, '../../shared') }, outfile: path.join(dir, 'fixture.js')
    })
    writeFileSync(path.join(dir, 'index.html'), '<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
    writeFileSync(path.join(dir, 'main.cjs'), `
      const { app, BrowserWindow } = require('electron')
      const path = require('node:path')
      const fs = require('node:fs')
      app.setPath('userData', path.join(__dirname, 'profile'))
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
        try {
          win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_, done) => done({ cancel: true }))
          await win.loadFile(path.join(__dirname, 'index.html'))
          const evidence = await win.webContents.executeJavaScript('window.checkActions()')
          fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(evidence))
        } catch (error) {
          fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ fatal: String(error) }))
        } finally { win.destroy(); app.quit() }
      }).catch(() => app.exit(1))
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(path.join(electronRoot, 'dist', executable), [path.join(dir, 'main.cjs')], { encoding: 'utf8', timeout: 30_000, env })
    expect(result.status, result.error?.message || result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8'))).toEqual({
      revealLabel: '在文件夹中显示', macHint: '在 Finder 中显示', windowsHint: 'Show in File Explorer',
      remoteButtons: 1, htmlActions: ['在文件夹中显示 · report.html', '另存为 · report.html'],
      folderError: '文件夹不可用', directoryCardName: '在 Finder 中打开文件夹 · results', directoryCardPath: '/synthetic/results', cancelledQuietly: true,
      context: {
        macMenu: '在 Finder 中显示', windowsMenu: 'Show in File Explorer', windowsDirectoryMenu: 'Open folder in File Explorer',
        onlyAfterChoice: true, keyboardFocus: true, escaped: true, staleContextIgnored: true, rightClickDefaults: [true, true, true]
      },
      calls: [
        ['w', 'test%20report.pdf', 'open', 's'], ['w', 'test%20report.pdf', 'reveal', 's'], ['w', 'test%20report.pdf', 'save', 's'],
        ['https://example.org/report.pdf'], ['folder', 'w', '/synthetic/results', 's'], ['folder', 'w', '/synthetic/results', 's'], ['w', 'report.html', 'reveal', 's'],
        ['w', 'sandbox:/mnt/data/example.pdf', 'reveal', 's'], ['w', 'report.html', 'reveal', 's'],
        ['w', 'test%20report.pdf', 'reveal', 's'], ['folder', 'w', '/synthetic/results', 's']
      ]
    })
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
})

const fixture = `
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useAppStore } from '../store'
import { AttachmentCard, AttachmentFolderCard, AttachmentFolderMention, AttachmentMention } from './ChatAttachment'

const calls = []
window.electronAPI = {
  platform: 'darwin',
  chatAttachment: async (...args) => { calls.push(args); return args[1].startsWith('sandbox:') ? 'cancelled' : 'ok' },
  openExternalUrl: async (...args) => { calls.push(args); return { ok: true } },
  openChatAttachmentFolder: async (...args) => { calls.push(['folder', ...args]); return 'unavailable' }
}
useAppStore.setState({ language: 'zh', currentWorkspace: { id: 'w' }, currentSessionId: 's' })
const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(<>
  <div id="local"><AttachmentCard target="test%20report.pdf" /></div>
  <div id="remote"><AttachmentCard target="https://example.org/report.pdf" /></div>
  <div id="directory"><AttachmentFolderMention target="/synthetic/results" label="输出目录" /></div>
  <div id="directory-card"><AttachmentFolderCard target="/synthetic/results" /></div>
  <div id="html"><AttachmentCard target="report.html" /></div>
  <div id="html-mention"><AttachmentMention target="report.html" label="报告" /></div>
  <div id="remote-mention"><AttachmentMention target="https://example.org/report.pdf" /></div>
  <div id="sandbox"><AttachmentCard target="sandbox:/mnt/data/example.pdf" /></div>
</>))
const buttons = id => [...document.querySelectorAll('#' + id + ' button')]
const next = () => new Promise(resolve => setTimeout(resolve, 25))
async function click(button) { button.click(); await next() }
const menuItem = () => document.querySelector('[role=menuitem]')
const contextMenu = element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
const key = (element, key, extras = {}) => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extras }))
window.checkActions = async () => {
  const [open, reveal, save] = buttons('local')
  const revealLabel = reveal.textContent
  const macHint = reveal.title
  const directoryCard = buttons('directory-card')[0]
  const directoryCardName = directoryCard.getAttribute('aria-label')
  const directoryCardPath = directoryCard.title
  for (const button of [open, reveal, save, buttons('remote')[0], buttons('directory')[0], directoryCard, buttons('html')[0], buttons('sandbox')[1]]) await click(button)
  const mention = document.querySelector('#html-mention a')
  key(mention, 'Enter')
  await next()
  const folderError = document.querySelector('#directory [role=status]')?.textContent
  const htmlActions = buttons('html').map(button => button.getAttribute('aria-label'))
  const cancelledQuietly = !document.querySelector('#sandbox [role=status]')

  const initialCalls = calls.length
  const localDefault = contextMenu(open)
  await next()
  const macMenu = menuItem()?.textContent
  const onlyAfterChoice = !localDefault && calls.length === initialCalls
  await click(menuItem())
  const rightClickDefaults = [buttons('remote')[0], document.querySelector('#remote-mention a'), buttons('sandbox')[0]].map(contextMenu)

  window.electronAPI.platform = 'win32'
  flushSync(() => useAppStore.setState({ language: 'en' }))
  mention.focus()
  key(mention, 'F10', { shiftKey: true })
  await next()
  const windowsMenu = menuItem()?.textContent
  const keyboardFocus = document.activeElement === menuItem()
  key(menuItem(), 'Escape')
  await next()
  const escaped = !menuItem() && document.activeElement === mention
  contextMenu(directoryCard)
  await next()
  const windowsDirectoryMenu = menuItem()?.textContent
  await click(menuItem())

  contextMenu(open)
  await next()
  const beforeSessionChange = calls.length
  flushSync(() => useAppStore.setState({ currentSessionId: 'another-session' }))
  await click(menuItem())
  const staleContextIgnored = calls.length === beforeSessionChange
  const context = { macMenu, windowsMenu, windowsDirectoryMenu, onlyAfterChoice, keyboardFocus, escaped, staleContextIgnored, rightClickDefaults }
  return { revealLabel, macHint, windowsHint: buttons('local')[1].title, remoteButtons: buttons('remote').length, htmlActions, folderError, directoryCardName, directoryCardPath, cancelledQuietly, context, calls }
}
`
