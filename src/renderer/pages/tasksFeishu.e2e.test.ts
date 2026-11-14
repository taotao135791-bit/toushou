import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('Feishu scheduled task controls in Electron', () => {
  it('requires a recipient for new tasks and retries only confirmed unsent runs', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'task-feishu-ui-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'tasksFeishu.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const env: NodeJS.ProcessEnv = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const run = spawnSync(electron, [path.resolve(__dirname, 'tasksFeishu.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const line = run.stdout?.split('\n').find(text => text.startsWith('E2E_RESULT '))
      expect(line, run.stderr).toBeDefined()
      const result = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(result, run.stdout).not.toHaveProperty('fatal')
      expect(result.initial.selected).toBe('')
      expect(result.initial.disabled).toBe(true)
      expect(result.initial.options.join(' ')).toContain('Synthetic team')
      expect(result.initial.options.join(' ')).toContain('oc_unknown_synthetic_87654321')
      expect(result.created.feishuChatId).toBe('oc_named_synthetic_12345678')
      expect(result.legacy).toEqual({ selected: '', disabled: false })
      expect(result.legacySaved.id).toBe('legacy-task')
      expect(result.legacySaved).not.toHaveProperty('feishuChatId')
      expect(result.history.unknown).toContain('Delivery unknown')
      expect(result.history.unknownRetry).toBe(false)
      expect(result.history.failedRetry).toBe(true)
      expect(result.retries).toEqual([{ taskId: 'delivery-task', runId: 'failed-run' }])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
