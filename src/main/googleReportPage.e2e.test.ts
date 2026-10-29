import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
function electronBinary(): string | null {
  try {
    const root = path.dirname(require_.resolve('electron/package.json'))
    const candidate = process.platform === 'win32' ? path.join(root, 'dist', 'electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron') : path.join(root, 'dist', 'electron')
    return existsSync(candidate) ? candidate : null
  } catch { return null }
}
function bundle(dir: string): boolean {
  try {
    type Builder = { buildSync(options: Record<string, unknown>): unknown }
    let esbuild: Builder
    try { esbuild = require_('esbuild') as Builder }
    catch { esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) as Builder }
    for (const [entry, output] of [['googleReportPage.ts', 'googleReportPage.js'], ['../shared/googleReport.ts', 'googleReport.js']]) {
      esbuild.buildSync({ entryPoints: [path.resolve(__dirname, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, output) })
    }
    return existsSync(path.join(dir, 'googleReportPage.js')) && existsSync(path.join(dir, 'googleReport.js'))
  } catch { return false }
}

describe('Google report page e2e (local synthetic Electron fixture)', () => {
  it('selects table export, captures scoped context and parses the downloaded CSV', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'google-report-modules-'))
    try {
      const binary = electronBinary(), bundled = bundle(dir)
      if (!binary || !bundled) {
        const reason = !binary ? 'electron binary unavailable' : 'esbuild unavailable'
        if (process.env.TOUSHOU_E2E_REQUIRED === '1') throw new Error(`Google report e2e required but skipped: ${reason}`)
        console.warn(`[Google report e2e] skipped (${reason})`)
        return
      }
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const harness = path.resolve(__dirname, '../../test/google-report-harness.cjs')
      const result = spawnSync(binary, [harness, dir], { encoding: 'utf8', timeout: 20_000, env })
      expect(result.status).toBe(0)
      const line = (result.stdout ?? '').split('\n').find(item => item.startsWith('E2E_RESULT '))
      expect(line, `fixture returned no result: ${(result.stderr ?? '').slice(0, 1000)}`).toBeDefined()
      const data = JSON.parse((line as string).slice('E2E_RESULT '.length))
      expect(data).not.toHaveProperty('fatal')
      expect(data.context).toMatchObject({ accountId: '1234567890', accountName: 'Demo', currency: 'USD', timezone: 'GMT+00', windowStart: '2026-10-29', windowEnd: '2026-10-29' })
      expect(data.graphClicked).toBe(false)
      expect(data.verified).toBe(true)
      expect(data.spend).toBe(9)
      expect(data.wrongColumn).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
