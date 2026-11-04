import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
it('keeps product selection separate from export and isolates verified readings (real Electron renderer)', { timeout: 30_000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-product-ui-'))
  try {
    const root = path.dirname(require_.resolve('electron/package.json'))
    const binary = process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
    if (!existsSync(binary)) {
      if (process.env.TOUSHOU_E2E_REQUIRED === '1') throw new Error('Electron required but unavailable')
      console.warn('[FB product UI] skipped: Electron unavailable')
      return
    }
    const esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) as { buildSync(options: Record<string, unknown>): void }
    esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../../../test/fb-report-product-ui.tsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' }, outfile: path.join(dir, 'ui.js'), define: { 'process.env.NODE_ENV': '"test"' } })
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="ui.js"></script>')
    const env: NodeJS.ProcessEnv = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(binary, [path.resolve(__dirname, '../../../test/fb-report-product-harness.cjs'), dir], { encoding: 'utf8', timeout: 20_000, env })
    expect(result.status, result.stderr).toBe(0)
    const line = result.stdout.split('\n').find((l) => l.startsWith('E2E_RESULT '))
    expect(line, result.stderr).toBeDefined()
    expect(JSON.parse(line!.slice('E2E_RESULT '.length))).toMatchObject({ passed: true, exports: 3 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
