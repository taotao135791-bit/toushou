import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

it('selects catalog models and round-trips custom limits in the Electron settings form', { timeout: 60000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'toushou-model-settings-'))
  try {
    const esbuild = require_(require_.resolve('esbuild', { paths: [require_.resolve('vite')] }))
    const bundle = (entry: string, output: string, platform: 'browser' | 'node') => esbuild.buildSync({
      entryPoints: [path.resolve(__dirname, entry)], outfile: path.join(dir, output),
      bundle: true, platform, format: platform === 'node' ? 'cjs' : 'iife', jsx: 'automatic',
      loader: { '.svg': 'dataurl', '.png': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../shared') },
      external: platform === 'node' ? ['electron', '*.node'] : []
    })
    bundle('CustomProviderModels.fixture.tsx', 'fixture.js', 'browser')
    bundle('../../main/customProviders.ts', 'backend.cjs', 'node')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require_('electron'), [path.join(__dirname, 'CustomProviderModels.harness.cjs'), dir], {
      encoding: 'utf8', timeout: 40000, env
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('MODEL_SETTINGS_OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
