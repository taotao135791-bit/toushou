import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

describe('ad-copy relay import in Electron', () => {
  it('keeps discovered models bound to their connection and preserves a failed import', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adscopy-models-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'AdsCopyModelsSection.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'AdsCopyModelsSection.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const line = result.stdout?.split('\n').find(s => s.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(data.afterAddressChange).toEqual([])
      expect(data.afterLateResponse).toEqual(['B-model', 'b-model'])
      expect(data.afterKeyChange).toEqual([])
      expect(data.afterProtocolChange).toEqual([])
      expect(data.afterPaste).toEqual([])
      expect(data.whileSaving.disabled).toBe(true)
      expect(data.whileSaving.saved).toEqual(['C-model', 'c-model'].map(model => ({ model, baseUrl: 'https://relay-c.example.test/v1', protocol: 'openai', keyMatches: true })))
      expect(data.afterFailure).toEqual({ selected: 2, existing: true, keyRetained: true })
      expect(data.afterSuccess).toEqual({ selected: 0, models: ['existing-model', 'C-model', 'c-model'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
