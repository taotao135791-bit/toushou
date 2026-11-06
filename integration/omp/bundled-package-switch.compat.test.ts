import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnCommandSync } from '../../src/main/command'
import { binaryAvailable, createIsolatedOmpEnvironment, requireBinary } from './isolated-runtime'

/** Real registry acceptance for the app's relink primitive; never calls a model. */
describe('current OMP — switching app-managed bundle locations', () => {
  it('replaces the actual same-version package root in both directions', () => {
    const bin = process.env.OMP_BIN || 'omp'
    if (!binaryAvailable(bin)) { requireBinary(bin); return }
    const iso = createIsolatedOmpEnvironment()
    const name = 'toushou-bundle-switch-proof'
    const run = (args: string[]) => {
      const result = spawnCommandSync(bin, args, {
        cwd: iso.agentDir,
        env: iso.env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      expect(result.error, 'OMP command must start in the isolated profile').toBeUndefined()
      expect(result.status, String(result.stderr ?? '')).toBe(0)
      return String(result.stdout ?? '')
    }
    try {
      const stable = path.join(iso.root, 'stable app resources')
      const beta = path.join(iso.root, 'beta app resources')
      for (const [directory, marker] of [[stable, 'stable'], [beta, 'beta']]) {
        mkdirSync(directory, { recursive: true })
        writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
          name, version: '1.0.0',
          omp: { extensions: ['index.ts'] }, pi: { extensions: ['index.ts'] }
        }))
        writeFileSync(path.join(directory, 'index.ts'), `// ${marker}\nexport default function(api) {}\n`)
      }
      for (const directory of [stable, beta, stable, beta]) {
        run(['plugin', 'link', directory])
        const registry = JSON.parse(run(['plugin', 'list', '--json'])) as {
          npm: Array<{ name: string; path: string; enabled: boolean }>
        }
        const rows = registry.npm.filter(row => row.name === name)
        expect(rows).toHaveLength(1)
        expect(rows[0].enabled).toBe(true)
        expect(realpathSync(rows[0].path)).toBe(realpathSync(directory))
        expect(readFileSync(path.join(rows[0].path, 'index.ts'), 'utf8'))
          .toBe(readFileSync(path.join(directory, 'index.ts'), 'utf8'))
      }
    } finally {
      iso.cleanup()
    }
  })
})
