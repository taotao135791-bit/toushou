import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

it('saves the assistant memory preference while leaving manual management available', { timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'toushou-memory-setting-'))
  try {
    const esbuild = createRequire(require_.resolve('vite/package.json'))('esbuild')
    esbuild.buildSync({
      stdin: { contents: fixture, resolveDir: __dirname, sourcefile: 'memory-setting.tsx', loader: 'tsx' },
      bundle: true, platform: 'browser', jsx: 'automatic',
      alias: { '@shared': path.resolve(__dirname, '../../shared') }, outfile: path.join(directory, 'fixture.js')
    })
    writeFileSync(path.join(directory, 'index.html'), '<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
    writeFileSync(path.join(directory, 'main.cjs'), harness)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require_('electron'), [path.join(directory, 'main.cjs')], { encoding: 'utf8', env, timeout: 25_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(path.join(directory, 'result.json'), 'utf8'))).toEqual({
      saved: [false, true, true],
      manualDeletions: [['global', 'synthetic-memory']],
      labelled: true
    })
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const harness = `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
app.setPath('userData', path.join(__dirname, 'profile'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(__dirname, 'index.html'))
    const result = await win.webContents.executeJavaScript('window.checkMemorySetting()')
    fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result))
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    app.quit()
  }
}).catch(error => { console.error(error); app.exit(1) })
`

const fixture = `
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import MemorySection from './MemorySection'
import { useAppStore } from '../store'

let enabled
let allowSaving = true
let entries = [{ id: 'synthetic-memory', text: 'Synthetic QA note', createdAt: 1, updatedAt: 1 }]
const saved = []
const manualDeletions = []
window.electronAPI = {
  getStore: async () => enabled,
  setStore: async (key, value) => {
    if (key !== 'memoryEnabled') throw new Error('wrong setting key')
    saved.push(value)
    if (allowSaving) enabled = value
    return allowSaving
  },
  memoryList: async () => ({ global: entries, project: [] }),
  memoryStorageGet: async () => ({ path: '/synthetic/memory', isDefault: true }),
  memoryDelete: async (scope, id) => {
    manualDeletions.push([scope, id])
    entries = entries.filter(entry => entry.id !== id)
    return true
  }
}
useAppStore.setState({ language: 'en' })
const root = createRoot(document.getElementById('root'))
const toggle = () => document.querySelector('[role="switch"][aria-label="Use long-term memory"]')
const checked = () => toggle()?.getAttribute('aria-checked')
async function waitFor(condition, label) {
  for (let attempts = 0; attempts < 60; attempts += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 16))
  }
  throw new Error(label)
}
window.checkMemorySetting = async () => {
  flushSync(() => root.render(<MemorySection key="first" />))
  await waitFor(() => checked() === 'true', 'older settings default to enabled')
  const describedBy = toggle().getAttribute('aria-describedby')
  const labelled = document.getElementById(describedBy)?.textContent.includes('manage saved entries')
  toggle().click()
  await waitFor(() => checked() === 'false' && enabled === false, 'turn off')
  flushSync(() => root.render(<MemorySection key="second" />))
  await waitFor(() => checked() === 'false', 'remember off when Settings reopens')
  const deleteButton = () => document.querySelector('button[aria-label="Delete"]')
  await waitFor(deleteButton, 'saved memory can still be managed while off')
  deleteButton().click()
  await waitFor(() => !deleteButton(), 'manual deletion updates the list')
  allowSaving = false
  toggle().click()
  await waitFor(() => checked() === 'false' && document.querySelector('[role="alert"]'), 'failed save restores the switch')
  allowSaving = true
  toggle().click()
  await waitFor(() => checked() === 'true' && enabled === true && !document.querySelector('[role="alert"]'), 'turn on again')
  return { saved, manualDeletions, labelled }
}
`
