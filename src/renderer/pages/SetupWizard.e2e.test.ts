import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

it('offers the platform install command and only confirms a successful clipboard write', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'setup-wizard-'))
  try {
    const electron = require_('electron') as string
    const esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild'))
    esbuild.buildSync({
      stdin: { contents: fixture, resolveDir: __dirname, sourcefile: 'setup-fixture.tsx', loader: 'tsx' },
      outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': path.resolve(__dirname, '../../shared') }, loader: { '.png': 'dataurl', '.svg': 'dataurl' }
    })
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
    const harnessFile = path.join(dir, 'harness.cjs')
    writeFileSync(harnessFile, harness)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(electron, [harnessFile, dir], { encoding: 'utf8', timeout: 45_000, env })
    expect(result.stdout, `${result.stdout}\n${result.stderr}`).toContain('SETUP_CHECKS_PASSED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const fixture = `
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SetupWizard from './SetupWizard'
import { useAppStore } from '../store'

const root = createRoot(document.getElementById('root')!)
const clipboard = {
  command: '',
  resolve: () => {},
  reject: () => {},
  writeText(command: string) {
    clipboard.command = command
    return new Promise<void>((resolve, reject) => {
      clipboard.resolve = resolve
      clipboard.reject = () => reject(new Error('synthetic clipboard failure'))
    })
  }
}
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
Object.assign(window, {
  electronAPI: { detectCli: async () => ({ available: false }), onInstallStatus: () => () => {} },
  setupFixture: {
    clipboard,
    mount(platform: string) {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: platform })
      useAppStore.setState({ cliAvailable: false, language: 'en' })
      root.render(<MemoryRouter><SetupWizard key={platform} /></MemoryRouter>)
    }
  }
})
`

const harness = `
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({show:false, width:1024,height:700,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}})
    const wc = win.webContents
    wc.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details, callback) => callback({cancel:true}))
    await win.loadFile(path.join(dir, 'index.html'))
    const js = source => wc.executeJavaScript(source)
    const wait = async expression => {
      const deadline = Date.now() + 5000
      while (!await js(expression)) {
        if (Date.now() > deadline) throw new Error('Timed out: ' + expression)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    const hasButton = label => '[...document.querySelectorAll("button")].some(b => b.textContent.trim() === ' + JSON.stringify(label) + ')'
    const clickCopy = () => js('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Copy").click()')

    await js('setupFixture.mount("Win32")')
    await wait('document.querySelector("label")?.textContent === "Run in PowerShell"')
    assert.equal(await js(hasButton('Auto-install agent runtime')), false)
    assert.equal(await js('document.querySelector("input").value'), 'irm https://omp.sh/install.ps1 | iex')
    await clickCopy()
    assert.equal(await js('setupFixture.clipboard.command'), 'irm https://omp.sh/install.ps1 | iex')
    assert.equal(await js(hasButton('Copied')), false)
    await js('setupFixture.clipboard.reject()')
    await wait('document.querySelector("[role=alert]")?.textContent.includes("Copy failed")')
    assert.equal(await js(hasButton('Copied')), false)
    await clickCopy()
    await js('setupFixture.clipboard.resolve()')
    await wait(hasButton('Copied'))

    await js('setupFixture.mount("MacIntel")')
    await wait(hasButton('Auto-install agent runtime'))
    await clickCopy()
    assert.equal(await js('setupFixture.clipboard.command'), 'curl -fsSL https://omp.sh/install | sh')
    await js('setupFixture.clipboard.resolve()')
    await wait(hasButton('Copied'))
    console.log('SETUP_CHECKS_PASSED')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.quit()
  }
})
`
