import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * Real-Electron E2E (review request on PR #8): boots the actual Electron
 * binary with a hidden window, a real WebContentsView browser panel, a local
 * fixture site, and the loopback bridge — then drives two session tokens
 * exactly like the bundled extension tools. Requires devDependencies
 * (electron + esbuild via the hoisted vite toolchain); skipped gracefully
 * when the environment cannot provide them.
 */

const require_ = createRequire(import.meta.url)

/** Resolve the real Electron executable from the devDependency layout. */
function electronBinary(): string | null {
  try {
    const pkgRoot = path.dirname(require_.resolve('electron/package.json'))
    const candidates =
      process.platform === 'win32'
        ? [path.join(pkgRoot, 'dist', 'electron.exe')]
        : process.platform === 'darwin'
          ? [path.join(pkgRoot, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')]
          : [path.join(pkgRoot, 'dist', 'electron')]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // electron not installed — skip (loudly, see below)
  }
  return null
}

function bundleModules(outFile: string): boolean {
  try {
    // esbuild ships inside vite's dependency bag under pnpm's strict layout;
    // resolve it directly first, then through vite's sibling directory.
    type EsbuildLike = { buildSync(options: Record<string, unknown>): unknown }
    let esbuild: EsbuildLike | null = null
    try {
      esbuild = require_('esbuild') as EsbuildLike
    } catch {
      const viteRoot = path.dirname(require_.resolve('vite/package.json'))
      esbuild = require_(path.join(viteRoot, '..', 'esbuild')) as EsbuildLike
    }
    if (!esbuild) return false
    esbuild.buildSync({
      entryPoints: [path.resolve(__dirname, '../browserUse.ts'), path.resolve(__dirname, '../browserPanel.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      // Keep './browserPanel' external so the bridge and the harness share
      // ONE module instance (and therefore one panel registry); otherwise
      // the inlined copy sees an empty registry.
      external: ['electron', './browserPanel'],
      outdir: outFile
    })
    return existsSync(path.join(outFile, 'browserUse.js')) && existsSync(path.join(outFile, 'browserPanel.js'))
  } catch {
    return false
  }
}

interface HarnessStep {
  name: string
  result: Record<string, unknown> & { ok?: boolean; error?: string; text?: string; url?: string; imagePath?: string }
}

function runHarness(modulesDir: string): { code: number; stdout: string; stderr: string } {
  const harness = path.resolve(__dirname, '../../../test/browser-use-harness.cjs')
  // An empty ELECTRON_RUN_AS_NODE still counts as set on Windows and turns
  // the binary into plain Node — remove it outright.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawnSync(electronBinary() as string, [harness, modulesDir], {
    encoding: 'utf-8',
    timeout: 90_000,
    env
  })
  return { code: proc.status ?? -1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' }
}

describe('browser-use e2e (real Electron panel)', () => {
  it('drives the real panel and enforces session/visibility rules', { timeout: 120_000 }, () => {
    const outDir = path.join(os.tmpdir(), 'toushou-browser-use-e2e')
    mkdirSync(outDir, { recursive: true })
    const bundled = bundleModules(outDir)
    const electron = electronBinary()
    if (!bundled || !electron) {
      // Never a silent pass: with TOUSHOU_E2E_REQUIRED=1 a missing toolchain
      // is a hard failure; otherwise report the skip on stderr.
      const reason = !bundled ? 'esbuild unavailable' : 'electron binary unavailable'
      if (process.env.TOUSHOU_E2E_REQUIRED === '1') {
        throw new Error(`browser-use e2e required but skipped: ${reason}`)
      }
      console.warn(`[browser-use e2e] skipped (${reason})`)
      return
    }
    void electron

    const { stdout, stderr } = runHarness(outDir)
    const line = stdout.split('\n').find((l) => l.startsWith('E2E_RESULT '))
    expect(line, `harness produced no verdict:\n${stdout.slice(0, 1000)}\n${stderr.slice(0, 1000)}`).toBeDefined()
    const parsed = JSON.parse((line as string).slice('E2E_RESULT '.length)) as
      | { fatal: string }
      | { steps: HarnessStep[] }
    expect(parsed).not.toHaveProperty('fatal')
    const steps = Object.fromEntries((parsed as { steps: HarnessStep[] }).steps.map((s) => [s.name, s.result]))

    expect(steps['A navigate'].ok).toBe(true)
    expect(steps['A snapshot'].ok).toBe(true)
    expect(steps['A snapshot'].text).toContain('snapshot-source-marker')

    // Session binding: B cannot act on A's page.
    expect(steps['B snapshot (expect denial)'].ok).toBe(false)
    expect(steps['B snapshot (expect denial)'].error).toBe('panel-owned-by-another-session')

    // Type + submit navigates the form; source snapshot reflects it.
    expect(steps['A type+submit'].ok).toBe(true)
    expect(steps['A snapshot after search'].url).toContain('searched')

    // Real click on a link navigates.
    expect(steps['A click link'].ok).toBe(true)
    expect(steps['A snapshot after click'].text).toContain('second page')

    // Screenshot fallback writes a PNG.
    expect(steps['A screenshot'].ok).toBe(true)
    expect(existsSync(String(steps['A screenshot'].imagePath))).toBe(true)

    // Hidden panel: operations refused.
    expect(steps['A snapshot while hidden (expect denial)'].ok).toBe(false)
    expect(steps['A snapshot while hidden (expect denial)'].error).toBe('panel-hidden')

    // Navigate reopens (allowed) and takeover flips ownership.
    expect(steps['A navigate while hidden (reopens)'].ok).toBe(true)
    expect(steps['B navigate (takeover)'].ok).toBe(true)
    expect(steps['A snapshot after takeover (expect denial)'].ok).toBe(false)
    expect(steps['A snapshot after takeover (expect denial)'].error).toBe('panel-owned-by-another-session')

    // Unknown token: 403.
    expect(steps['unknown token (expect 403)'].ok).toBe(true)
  })
})
