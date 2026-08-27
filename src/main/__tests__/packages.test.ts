import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const cliState = vi.hoisted(() => ({
  cli: { command: 'pi', path: '/usr/local/bin/pi', available: true },
  spawn: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: cliState.spawn }))

// packages.ts pulls in ./omp (CLI detection). Keep the tests hermetic while
// allowing explicit current-OMP cases to exercise the native CLI branch.
vi.mock('../omp', () => ({
  detectCli: () => cliState.cli,
  executableSearchDirs: () => []
}))

import {
  classifySource,
  isPinned,
  packageEnabled,
  resolvePackagePath,
  canonicalSourceForCommand,
  parsePackages,
  parseOmpPluginCapabilities,
  parseOmpPluginList,
  listPackages,
  setPackageEnabled,
  resourceEntries,
  normalizeOmpPluginSource
} from '../packages'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-gui-pkg-'))
  cliState.cli = { command: 'pi', path: '/usr/local/bin/pi', available: true }
  cliState.spawn.mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeSettings(settings: unknown) {
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
}

function mockCliResult(stdout: string, code = 0, stderr = '') {
  cliState.spawn.mockImplementationOnce(() => {
    const stdoutStream = new EventEmitter()
    const stderrStream = new EventEmitter()
    const proc = Object.assign(new EventEmitter(), {
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: vi.fn()
    })
    queueMicrotask(() => {
      if (stdout) stdoutStream.emit('data', Buffer.from(stdout))
      if (stderr) stderrStream.emit('data', Buffer.from(stderr))
      proc.emit('exit', code)
    })
    return proc
  })
}

describe('classifySource', () => {
  it('classifies npm sources', () => {
    expect(classifySource('npm:pi-web-access')).toBe('npm')
    expect(classifySource('npm:@scope/pkg@1.0.0')).toBe('npm')
    expect(classifySource('pi-web-access')).toBe('npm')
    expect(classifySource('@scope/pkg')).toBe('npm')
  })

  it('classifies git sources', () => {
    expect(classifySource('git:github.com/user/repo@v1')).toBe('git')
    expect(classifySource('github:user/repo#v1')).toBe('git')
    expect(classifySource('https://github.com/user/repo')).toBe('git')
    expect(classifySource('ssh://git@github.com/user/repo')).toBe('git')
    expect(classifySource('git@github.com:user/repo')).toBe('git')
  })

  it('classifies local sources', () => {
    expect(classifySource('/abs/path/pkg')).toBe('local')
    expect(classifySource('./rel/pkg')).toBe('local')
    expect(classifySource('../../../../tmp/pi-demo-ext')).toBe('local')
    expect(classifySource('~/packages/foo')).toBe('local')
  })
})

describe('normalizeOmpPluginSource', () => {
  it('normalizes documented GitHub shorthand, links and legacy Pi spelling', () => {
    expect(normalizeOmpPluginSource('owner/repo')).toBe('github:owner/repo')
    expect(normalizeOmpPluginSource('owner/repo#v1.2.0')).toBe('github:owner/repo#v1.2.0')
    expect(normalizeOmpPluginSource('https://github.com/owner/repo.git')).toBe('github:owner/repo')
    expect(normalizeOmpPluginSource('git:github.com/owner/repo@main')).toBe('github:owner/repo#main')
  })

  it('keeps local paths and arbitrary supported Git URLs intact', () => {
    expect(normalizeOmpPluginSource('./my-plugin')).toBe('./my-plugin')
    expect(normalizeOmpPluginSource('git@github.com:owner/repo')).toBe('git@github.com:owner/repo')
    expect(normalizeOmpPluginSource('https://github.com/owner/repo/tree/main')).toBe('github:owner/repo#main')
    expect(normalizeOmpPluginSource('https://github.com/owner/repo/tree/main/')).toBe('github:owner/repo#main')
    expect(normalizeOmpPluginSource('https://github.com/owner/repo/blob/main/index.ts')).toBe(
      'https://github.com/owner/repo/blob/main/index.ts'
    )
  })

  it('removes only the legacy npm prefix for current OMP', () => {
    expect(normalizeOmpPluginSource('npm:@scope/plugin@1.2.3')).toBe('@scope/plugin@1.2.3')
  })
})

describe('isPinned', () => {
  it('detects pinned npm versions', () => {
    expect(isPinned('npm:pkg@1.2.3', 'npm')).toBe(true)
    expect(isPinned('@scope/pkg@1.0.0', 'npm')).toBe(true)
    expect(isPinned('npm:pkg', 'npm')).toBe(false)
    expect(isPinned('@scope/pkg', 'npm')).toBe(false)
  })

  it('detects git refs', () => {
    expect(isPinned('git:github.com/user/repo@v1', 'git')).toBe(true)
    expect(isPinned('https://github.com/user/repo', 'git')).toBe(false)
  })

  it('never pins local paths', () => {
    expect(isPinned('/abs/path', 'local')).toBe(false)
  })
})

describe('packageEnabled', () => {
  it('treats string entries as enabled', () => {
    expect(packageEnabled('npm:pkg')).toBe(true)
  })

  it('treats all-empty object form as disabled', () => {
    expect(
      packageEnabled({ source: 'npm:pkg', extensions: [], skills: [], prompts: [], themes: [] })
    ).toBe(false)
  })

  it('treats partial filters as enabled', () => {
    expect(packageEnabled({ source: 'npm:pkg', skills: ['a'] })).toBe(true)
    expect(packageEnabled({ source: 'npm:pkg', extensions: [] })).toBe(true)
  })
})

describe('resolvePackagePath', () => {
  it('resolves npm packages under agent npm dir', () => {
    expect(resolvePackagePath('npm:pi-web-access', 'npm', dir)).toBe(
      path.join(dir, 'npm', 'node_modules', 'pi-web-access')
    )
    expect(resolvePackagePath('npm:@scope/pkg@1.0.0', 'npm', dir)).toBe(
      path.join(dir, 'npm', 'node_modules', '@scope', 'pkg')
    )
  })

  it('resolves git packages under agent git dir', () => {
    expect(resolvePackagePath('git:github.com/user/repo@v1', 'git', dir)).toBe(
      path.join(dir, 'git', 'github.com', 'user', 'repo')
    )
    expect(resolvePackagePath('https://github.com/user/repo.git', 'git', dir)).toBe(
      path.join(dir, 'git', 'github.com', 'user', 'repo')
    )
    expect(resolvePackagePath('git@github.com:user/repo', 'git', dir)).toBe(
      path.join(dir, 'git', 'github.com', 'user', 'repo')
    )
  })

  it('resolves local paths relative to the settings dir', () => {
    expect(resolvePackagePath('./my-ext', 'local', dir)).toBe(path.join(dir, 'my-ext'))
  })
})

describe('parsePackages', () => {
  it('reads metadata and resources from a local package dir', () => {
    const pkgDir = path.join(dir, 'demo')
    mkdirSync(path.join(pkgDir, 'extensions'), { recursive: true })
    mkdirSync(path.join(pkgDir, 'skills', 'hello'), { recursive: true })
    mkdirSync(path.join(pkgDir, 'prompts'), { recursive: true })
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        displayName: 'Demo Pack',
        description: 'demo package',
        version: '1.2.3'
      })
    )
    writeFileSync(path.join(pkgDir, 'extensions', 'demo.ts'), 'export default () => {}')
    writeFileSync(path.join(pkgDir, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n')
    writeFileSync(path.join(pkgDir, 'prompts', 'review.md'), '# review')

    const packages = parsePackages({ packages: ['./demo'] }, dir)
    expect(packages).toHaveLength(1)
    const pkg = packages[0]
    expect(pkg.name).toBe('Demo Pack')
    expect(pkg.version).toBe('1.2.3')
    expect(pkg.enabled).toBe(true)
    expect(pkg.kind).toBe('local')
    expect(pkg.resources).toEqual(
      expect.arrayContaining([
        { type: 'extension', name: 'demo' },
        { type: 'skill', name: 'hello' },
        { type: 'prompt', name: 'review' }
      ])
    )
  })

  it('dedupes manifest dirs that overlap with conventions', () => {
    const pkgDir = path.join(dir, 'demo2')
    mkdirSync(path.join(pkgDir, 'extensions'), { recursive: true })
    mkdirSync(path.join(pkgDir, 'skills', 'hello'), { recursive: true })
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'demo2',
        pi: { extensions: ['./extensions'], skills: ['./skills/'] }
      })
    )
    writeFileSync(path.join(pkgDir, 'extensions', 'demo.ts'), 'export default () => {}')
    writeFileSync(path.join(pkgDir, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n')

    const packages = parsePackages({ packages: ['./demo2'] }, dir)
    expect(packages[0].resources).toEqual([
      { type: 'extension', name: 'demo' },
      { type: 'skill', name: 'hello' }
    ])
  })

  it('lists manifest entries that point at files', () => {
    const pkgDir = path.join(dir, 'filepkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'filepkg', pi: { extensions: ['./index.ts'] } })
    )
    writeFileSync(path.join(pkgDir, 'index.ts'), 'export default () => {}')

    const packages = parsePackages({ packages: ['./filepkg'] }, dir)
    expect(packages[0].resources).toEqual([{ type: 'extension', name: 'filepkg' }])
  })

  it('marks all-empty object entries as disabled', () => {
    const packages = parsePackages(
      {
        packages: [
          { source: 'npm:pkg', extensions: [], skills: [], prompts: [], themes: [] }
        ]
      },
      dir
    )
    expect(packages[0].enabled).toBe(false)
  })

  it('treats a lone local file as a single extension', () => {
    writeFileSync(path.join(dir, 'single.ts'), 'export default () => {}')
    const packages = parsePackages({ packages: ['./single.ts'] }, dir)
    expect(packages[0].resources).toEqual([{ type: 'extension', name: 'single' }])
  })

  it('skips duplicate entries', () => {
    const packages = parsePackages({ packages: ['npm:a', 'npm:a'] }, dir)
    expect(packages).toHaveLength(1)
  })
})

describe('canonicalSourceForCommand', () => {
  it('resolves relative local sources against the settings dir', () => {
    expect(canonicalSourceForCommand('../../../../tmp/pi-demo-ext', '/Users/x/.pi/agent')).toBe(
      '/tmp/pi-demo-ext'
    )
    expect(canonicalSourceForCommand('./my-ext', dir)).toBe(path.join(dir, 'my-ext'))
  })

  it('leaves npm and git sources untouched', () => {
    expect(canonicalSourceForCommand('npm:pkg', dir)).toBe('npm:pkg')
    expect(canonicalSourceForCommand('git:github.com/u/r@v1', dir)).toBe('git:github.com/u/r@v1')
  })
})

describe('setPackageEnabled', () => {
  it('rewrites a string entry to the disabled object form and back', async () => {
    writeSettings({ theme: 'dark', packages: ['npm:pkg'] })

    expect((await setPackageEnabled('npm:pkg', false, dir)).ok).toBe(true)
    let packages = await listPackages(dir)
    expect(packages[0].enabled).toBe(false)

    expect((await setPackageEnabled('npm:pkg', true, dir)).ok).toBe(true)
    packages = await listPackages(dir)
    expect(packages[0].enabled).toBe(true)
    // unrelated settings survive the rewrite
    expect(await listPackages(dir)).toHaveLength(1)
  })

  it('preserves unrelated settings keys', async () => {
    writeSettings({ theme: 'dark', packages: ['npm:pkg'] })
    await setPackageEnabled('npm:pkg', false, dir)
    const raw = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf-8'))
    expect(raw.theme).toBe('dark')
  })

  it('fails for unknown sources', async () => {
    writeSettings({ packages: [] })
    expect((await setPackageEnabled('npm:nope', false, dir)).ok).toBe(false)
  })
})

describe('current OMP plugin output', () => {
  it('uses native list output instead of stale legacy settings.json', async () => {
    writeSettings({ packages: ['npm:legacy-only'] })
    cliState.cli = { command: 'omp', path: '/fake/omp', available: true }
    mockCliResult(JSON.stringify({ npm: [], marketplace: [] }))

    await expect(listPackages(dir)).resolves.toEqual([])
    expect(cliState.spawn).toHaveBeenCalledWith(
      '/fake/omp',
      ['plugin', 'list', '--json'],
      expect.objectContaining({ env: expect.any(Object) })
    )
  })

  it('uses the native enable command and marketplace scope', async () => {
    cliState.cli = { command: 'omp', path: '/fake/omp', available: true }
    mockCliResult('ACTION install|uninstall|list|enable|disable|upgrade')
    mockCliResult('disabled review@company-marketplace')

    await expect(
      setPackageEnabled('review@company-marketplace', false, dir, 'project')
    ).resolves.toMatchObject({ ok: true })
    expect(cliState.spawn.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      ['plugin', '--help'],
      ['plugin', 'disable', 'review@company-marketplace', '--scope', 'project']
    ])
  })

  it('uses native plugin rows, including separate marketplace scopes', () => {
    const packages = parseOmpPluginList({
      npm: [
        {
          name: '@scope/native-plugin',
          version: '1.2.3',
          path: '/tmp/native-plugin',
          enabled: false,
          manifest: { description: 'Native plugin' }
        }
      ],
      marketplace: [
        {
          id: 'review@company-marketplace',
          scope: 'project',
          entries: [
            {
              scope: 'project',
              installPath: '/tmp/review',
              version: '2.0.0',
              enabled: true
            }
          ]
        },
        {
          id: 'review@company-marketplace',
          scope: 'user',
          entries: [
            {
              scope: 'user',
              installPath: '/tmp/review-user',
              version: '1.0.0',
              enabled: false
            }
          ]
        }
      ]
    })

    expect(packages).toEqual([
      expect.objectContaining({
        source: 'omp:npm:user:@scope/native-plugin',
        commandSource: '@scope/native-plugin',
        kind: 'npm',
        enabled: false,
        canUpdate: false
      }),
      expect.objectContaining({
        source: 'omp:marketplace:project:review@company-marketplace',
        commandSource: 'review@company-marketplace',
        kind: 'marketplace',
        scope: 'project',
        enabled: true,
        canUpdate: true
      }),
      expect.objectContaining({
        source: 'omp:marketplace:user:review@company-marketplace',
        commandSource: 'review@company-marketplace',
        kind: 'marketplace',
        scope: 'user',
        enabled: false,
        canUpdate: true
      })
    ])
  })

  it('only exposes drag-to-toggle after native enable and disable are advertised', () => {
    expect(parseOmpPluginCapabilities('ACTION install|list|enable|disable|upgrade')).toEqual({
      profile: 'current',
      canToggle: true,
      canUpdate: true
    })
    expect(parseOmpPluginCapabilities('ACTION install|list|uninstall')).toEqual({
      profile: 'current',
      canToggle: false,
      canUpdate: false
    })
  })
})

describe('resourceEntries (manifest path traversal)', () => {
  it('keeps valid nested resource paths inside the package dir', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omp-pkg-traversal-'))
    try {
      const pkg = path.join(base, 'pkg')
      mkdirSync(path.join(pkg, 'src', 'ext'), { recursive: true })
      mkdirSync(path.join(pkg, 'dist'), { recursive: true })
      writeFileSync(path.join(pkg, 'dist', 'index.js'), 'export default () => {}')
      const entries = resourceEntries(
        pkg,
        { pi: { extensions: ['src/ext', 'dist/index.js'] } },
        'extensions',
        'extensions'
      )
      expect(entries).toContain(path.join(pkg, 'src', 'ext'))
      expect(entries).toContain(path.join(pkg, 'dist', 'index.js'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rejects manifest resource paths that escape the package dir', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omp-pkg-escape-'))
    try {
      const pkg = path.join(base, 'pkg')
      mkdirSync(path.join(pkg, 'extensions'), { recursive: true })
      const entries = resourceEntries(
        pkg,
        { pi: { extensions: ['../../secret', '../..', '/etc'] } },
        'extensions',
        'extensions'
      )
      // Every escaping path is dropped; only the convention remains.
      expect(entries.some((e) => e.includes('secret') || e.startsWith('/etc'))).toBe(false)
      expect(entries).toContain(path.join(pkg, 'extensions'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('resourceEntries realpath containment', () => {
  it('allows an inside-package symlink', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omp-pkg-realpath-'))
    try {
      const pkg = path.join(base, 'pkg')
      const real = path.join(base, 'pkg-real')
      mkdirSync(real, { recursive: true })
      mkdirSync(path.join(real, 'extensions'), { recursive: true })
      writeFileSync(path.join(real, 'extensions', 'index.ts'), 'export default () => {}')
      symlinkSync(real, pkg)

      const entries = resourceEntries(pkg, { pi: { extensions: ['./extensions/index.ts'] } }, 'extensions', 'extensions')
      expect(entries).toContain(path.join(pkg, 'extensions', 'index.ts'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rejects an outside-package symlink', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omp-pkg-escape-'))
    try {
      const pkg = path.join(base, 'pkg')
      const outside = path.join(base, 'outside')
      mkdirSync(pkg, { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(path.join(outside, 'secret.ts'), 'secret')
      symlinkSync(path.join(outside, 'secret.ts'), path.join(pkg, 'extensions'))

      const entries = resourceEntries(pkg, { pi: { extensions: ['./extensions'] } }, 'extensions', 'extensions')
      expect(entries.some((e) => e.includes('secret'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rejects a nested outside symlink', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omp-pkg-nested-escape-'))
    try {
      const pkg = path.join(base, 'pkg')
      const outside = path.join(base, 'outside')
      mkdirSync(pkg, { recursive: true })
      mkdirSync(path.join(pkg, 'skills'), { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(path.join(outside, 'SKILL.md'), 'name: leaked\n')
      symlinkSync(outside, path.join(pkg, 'skills', 'leaked'))

      const entries = resourceEntries(pkg, null, 'skills', 'skills')
      expect(entries.some((e) => e.includes('leaked'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('drops a broken symlink instead of crashing', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omp-pkg-broken-'))
    try {
      const pkg = path.join(base, 'pkg')
      mkdirSync(pkg, { recursive: true })
      symlinkSync(path.join(base, 'missing'), path.join(pkg, 'extensions'))

      const entries = resourceEntries(pkg, { pi: { extensions: ['./extensions'] } }, 'extensions', 'extensions')
      expect(entries.some((e) => e.includes('extensions'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
