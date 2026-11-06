import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import YAML from 'yaml'
import { describe, expect, it, vi } from 'vitest'

const require_ = createRequire(import.meta.url)
const config = require_('../../../electron-builder.beta.cjs')
const { configureBeta } = require_('../../../build/beta-bootstrap.cjs') as { configureBeta: (app: Record<string, unknown>, env: Record<string, string>, argv: string[], mkdir: (...args: unknown[]) => void) => { profile: string } }
const { validateConfig, validateRef, expectedAssets, stageAssets, verifyChecksums } = require_('../../../tools/beta-release.cjs') as {
  validateConfig: () => { version: string; tag: string }
  validateRef: (type: string, name: string) => void
  expectedAssets: (platform: string) => string[]
  stageAssets: (directory: string, platform: string, destination: string) => void
  verifyChecksums: (directory: string, platform: string) => void
}

describe('isolated beta packaging', () => {
  it('uses separate identity, entry, output and channel while the stable configuration stays stable', () => {
    const stable = require_('../../../electron-builder.json')
    const metadata = validateConfig()
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+-beta\.\d+$/)
    expect(metadata.tag).toBe(`beta-v${metadata.version}`)
    expect(stable.appId).toBe('com.toushou.desktop')
    expect(stable.productName).toBe('投手')
    expect(config.directories.output).toBe('release-beta')
    expect(config.extraMetadata).toMatchObject({ name: 'toushou-beta', productName: '投手 Beta', main: 'dist-electron/main/beta.cjs' })
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(() => validateRef('tag', metadata.tag)).not.toThrow()
    for (const [type, ref] of [['branch', metadata.tag], ['tag', `v${metadata.version}`], ['tag', 'beta-v2.4.0'], ['tag', 'beta-v999.0.0-beta.1']]) expect(() => validateRef(type, ref)).toThrow()
  })

  it('resolves to exactly one beta publisher in the real electron-builder config loader', async () => {
    const builderRequire = createRequire(require_.resolve('electron-builder'))
    const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
    const { getConfig } = libraryRequire('./util/config/config')
    const effective = await getConfig(path.resolve(__dirname, '../../..'), path.resolve(__dirname, '../../../electron-builder.beta.cjs'), null)
    expect(effective.publish).toEqual([{ provider: 'github', owner: 'taotao135791-bit', repo: 'toushou', channel: 'beta', releaseType: 'prerelease' }])
    expect(effective.generateUpdatesFilesForAllChannels).toBe(false)
    expect(effective.mac.target).toEqual(require_('../../../electron-builder.json').mac.target)
  })

  it('selects the existing GUI workspace before Main runs and preserves the current CLI profile', () => {
    const app = { getPath: vi.fn(() => path.join(tmpdir(), 'synthetic-appdata')), setName: vi.fn(), setPath: vi.fn() }
    const env = { HOME: '/synthetic/home', PI_CODING_AGENT_DIR: '/synthetic/stable-agent', OMP_PROFILE: 'saved-stable', PI_PROFILE: 'saved-stable' }
    const mkdir = vi.fn()
    const result = configureBeta(app, env, ['app'], mkdir)
    expect(result.profile).toBe(path.join(tmpdir(), 'synthetic-appdata', 'toushou'))
    expect(app.setName).toHaveBeenCalledWith('toushou')
    expect(app.setPath).toHaveBeenCalledWith('userData', result.profile)
    expect(env).toMatchObject({ HOME: '/synthetic/home', PI_CODING_AGENT_DIR: '/synthetic/stable-agent', OMP_PROFILE: 'saved-stable', PI_PROFILE: 'saved-stable', TOUSHOU_RELEASE_CHANNEL: 'beta' })
    expect(mkdir).toHaveBeenCalledWith(result.profile, { recursive: true, mode: 0o700 })
    expect(mkdir).toHaveBeenCalledTimes(1)
    const source = readFileSync(path.resolve(__dirname, '../../../build/beta-bootstrap.cjs'), 'utf8')
    expect(source.indexOf("configureBeta(require('electron').app)")).toBeLessThan(source.indexOf("require('./index.js')"))
  })

  it('honors the packaged smoke explicit profile and rejects ambiguous or unsafe overrides', () => {
    const app = { getPath: vi.fn(), setName: vi.fn(), setPath: vi.fn() }
    const profile = path.join(tmpdir(), 'synthetic-beta-smoke')
    for (const argv of [[`--user-data-dir=${profile}`], ['--user-data-dir', profile]]) {
      expect(configureBeta(app, {}, argv, vi.fn())).toEqual({ profile })
    }
    expect(app.getPath).not.toHaveBeenCalled()
    for (const argv of [['--user-data-dir=relative'], ['--user-data-dir'], ['--user-data-dir='], [`--user-data-dir=${profile}`, `--user-data-dir=${profile}`]]) {
      const mkdir = vi.fn()
      expect(() => configureBeta(app, {}, argv, mkdir)).toThrow()
      expect(mkdir).not.toHaveBeenCalled()
    }
  })

  it('runs the installed entry configuration before loading any production Main module', () => {
    const profile = path.join(tmpdir(), 'synthetic-beta-entry')
    const env = { PI_CODING_AGENT_DIR: path.join(profile, 'private-agent') }
    const app = { setName: vi.fn(), setPath: vi.fn() }
    const mainModule = { exports: {} }
    const loaded = vi.fn()
    const fakeRequire = Object.assign((name: string) => {
      if (name === 'node:path') return path
      if (name === 'node:fs') return { mkdirSync: vi.fn() }
      if (name === 'electron') return { app }
      if (name === './index.js') {
        expect(app.setName).toHaveBeenCalledWith('toushou')
        expect(app.setPath).toHaveBeenCalledWith('userData', profile)
        expect(env).toMatchObject({ TOUSHOU_RELEASE_CHANNEL: 'beta', PI_CODING_AGENT_DIR: path.join(profile, 'private-agent') })
        loaded()
        return {}
      }
      throw new Error('Unexpected bootstrap dependency')
    }, { main: mainModule })
    vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../../build/beta-bootstrap.cjs'), 'utf8'), { require: fakeRequire, module: mainModule, process: { env, argv: ['app', `--user-data-dir=${profile}`] } })
    expect(loaded).toHaveBeenCalledOnce()
  })

  it.each(['mac', 'windows'])('validates actual %s archives, manifests and checksum coverage', platform => {
    const directory = mkdtempSync(path.join(tmpdir(), 'synthetic-beta-assets-'))
    const staged = mkdtempSync(path.join(tmpdir(), 'synthetic-beta-staged-'))
    try {
      const assets = expectedAssets(platform)
      for (const filename of assets) writeFileSync(path.join(directory, filename), `synthetic ${filename}`)
      const files = assets.filter(filename => /\.(zip|exe)$/.test(filename)).map(url => {
        const content = readFileSync(path.join(directory, url))
        return { url, size: content.length, sha512: createHash('sha512').update(content).digest('base64') }
      })
      const manifest = platform === 'mac' ? 'beta-mac.yml' : 'beta.yml'
      writeFileSync(path.join(directory, manifest), YAML.stringify({ version: config.extraMetadata.version, files }))
      stageAssets(directory, platform, staged)
      expect(() => verifyChecksums(staged, platform)).not.toThrow()
      writeFileSync(path.join(staged, 'latest.yml'), 'stable pollution')
      expect(() => verifyChecksums(staged, platform)).toThrow('Stable update manifest')
      rmSync(path.join(staged, 'latest.yml'))
      writeFileSync(path.join(staged, files[0].url), 'changed')
      expect(() => verifyChecksums(staged, platform)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(staged, { recursive: true, force: true })
    }
  })

  it('keeps beta publication away from stable tags/latest and gates it behind full verification', () => {
    const workflow = YAML.parse(readFileSync(path.resolve(__dirname, '../../../.github/workflows/beta-release.yml'), 'utf8'))
    expect(workflow.on.push.tags).toEqual(['beta-v*'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.publish.if).toBe("github.event_name == 'push'")
    expect(workflow.jobs.publish.permissions).toEqual({ contents: 'write' })
    expect(workflow.jobs.publish.needs).toEqual(['metadata', 'verify-assets'])
    const build = workflow.jobs.build.steps.map((step: { run?: string }) => step.run ?? '').join('\n')
    for (const gate of ['pnpm typecheck', 'pnpm test', 'pnpm test:omp', 'pnpm build', 'beta-release.cjs prepare', '--publish never', 'verify-package', 'release-smoke.cjs', 'beta-release.cjs stage']) expect(build).toContain(gate)
    const publish = workflow.jobs.publish.steps.map((step: { run?: string }) => step.run ?? '').join('\n')
    expect(publish).toContain('--draft --prerelease --latest=false')
    expect(publish).toContain('--draft=false --prerelease --latest=false')
    expect(publish).toContain('sha256sum --check SHA256SUMS-beta-mac.txt')
    expect(publish).toContain('gh release download')
    expect(expectedAssets('mac').length + expectedAssets('windows').length + 2).toBe(14)
  })
})
