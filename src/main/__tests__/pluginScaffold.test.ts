import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PluginScaffoldSpec } from '../../shared/types'
import { scaffoldPlugin } from '../pluginScaffold'

const fsMock = vi.hoisted(() => ({ failWrites: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsMock.failWrites) throw new Error('forced write failure')
      return actual.writeFileSync(...args)
    }
  }
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-gui-scaffold-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function spec(overrides: Partial<PluginScaffoldSpec> = {}): PluginScaffoldSpec {
  return {
    name: 'pi-demo',
    description: 'demo package',
    version: '0.1.0',
    parentDir: dir,
    extension: true,
    skill: true,
    prompt: true,
    template: 'blank',
    ...overrides
  }
}

describe('scaffoldPlugin', () => {
  it('creates the full structure when every resource type is checked', () => {
    const res = scaffoldPlugin(spec())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.dir).toBe(path.join(dir, 'pi-demo'))
    expect(res.files).toEqual([
      'package.json',
      'README.md',
      'extensions/index.ts',
      'skills/pi-demo/SKILL.md',
      'prompts/pi-demo.md'
    ])
    for (const file of res.files) {
      expect(existsSync(path.join(res.dir, ...file.split('/')))).toBe(true)
    }
    const manifest = JSON.parse(readFileSync(path.join(res.dir, 'package.json'), 'utf-8'))
    expect(manifest.name).toBe('pi-demo')
    expect(manifest.keywords).toContain('pi-package')
    expect(manifest.pi).toEqual({
      extensions: ['extensions/index.ts'],
      skills: ['skills'],
      prompts: ['prompts']
    })
    const skill = readFileSync(path.join(res.dir, 'skills/pi-demo/SKILL.md'), 'utf-8')
    expect(skill).toContain('---\nname: pi-demo\ndescription: demo package\n---')
    const ext = readFileSync(path.join(res.dir, 'extensions/index.ts'), 'utf-8')
    expect(ext).toContain('export default function')
    expect(ext).toContain('@mariozechner/pi-coding-agent')
  })

  it('writes only the checked resource types', () => {
    const res = scaffoldPlugin(spec({ extension: false, skill: true, prompt: false }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files).toEqual(['package.json', 'README.md', 'skills/pi-demo/SKILL.md'])
    const manifest = JSON.parse(readFileSync(path.join(res.dir, 'package.json'), 'utf-8'))
    expect(manifest.pi).toEqual({ skills: ['skills'] })
    expect(manifest.files).toEqual(['skills'])
    expect(manifest.peerDependencies).toBeUndefined()
    expect(existsSync(path.join(res.dir, 'extensions'))).toBe(false)
    expect(existsSync(path.join(res.dir, 'prompts'))).toBe(false)
  })

  it('nests scoped package names as directories', () => {
    const res = scaffoldPlugin(
      spec({ name: '@acme/pi-demo', extension: false, skill: false, prompt: true })
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.dir).toBe(path.join(dir, '@acme', 'pi-demo'))
    expect(res.files).toContain('prompts/pi-demo.md')
    expect(existsSync(path.join(res.dir, 'prompts', 'pi-demo.md'))).toBe(true)
  })

  it('refuses to overwrite an existing non-empty directory', () => {
    const target = path.join(dir, 'pi-demo')
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, 'keep.txt'), 'mine')
    const res = scaffoldPlugin(spec())
    expect(res).toEqual({ ok: false, error: 'dir-not-empty' })
    expect(readFileSync(path.join(target, 'keep.txt'), 'utf-8')).toBe('mine')
  })

  it('allows writing into an existing empty directory', () => {
    mkdirSync(path.join(dir, 'pi-demo'), { recursive: true })
    expect(scaffoldPlugin(spec()).ok).toBe(true)
  })

  it('refuses a package directory symlink instead of writing through it', () => {
    const selected = path.join(dir, 'selected')
    const outside = path.join(dir, 'outside')
    mkdirSync(selected)
    mkdirSync(outside)
    symlinkSync(outside, path.join(selected, 'pi-demo'))

    expect(scaffoldPlugin(spec({ parentDir: selected }))).toEqual({ ok: false, error: 'unsafe-path' })
    expect(existsSync(path.join(outside, 'package.json'))).toBe(false)
  })

  it('refuses a scoped package parent symlink instead of writing through it', () => {
    const selected = path.join(dir, 'selected')
    const outside = path.join(dir, 'outside')
    mkdirSync(selected)
    mkdirSync(outside)
    symlinkSync(outside, path.join(selected, '@acme'))

    expect(
      scaffoldPlugin(spec({ parentDir: selected, name: '@acme/pi-demo', extension: false, skill: true }))
    ).toEqual({ ok: false, error: 'unsafe-path' })
    expect(existsSync(path.join(outside, 'pi-demo', 'package.json'))).toBe(false)
  })

  it('publishes a completed staging tree and leaves no staging folder behind', () => {
    const res = scaffoldPlugin(spec())
    expect(res.ok).toBe(true)
    expect(readdirSync(dir).filter((name) => name.startsWith('.omp-scaffold-'))).toEqual([])
    expect(existsSync(path.join(dir, 'pi-demo', 'package.json'))).toBe(true)
  })

  it('cleans the staged tree after a write failure so the same grant can retry', () => {
    fsMock.failWrites = true
    try {
      expect(scaffoldPlugin(spec())).toMatchObject({ ok: false, error: 'write-failed' })
    } finally {
      fsMock.failWrites = false
    }
    expect(existsSync(path.join(dir, 'pi-demo'))).toBe(false)
    expect(readdirSync(dir).filter((name) => name.startsWith('.omp-scaffold-'))).toEqual([])
    expect(scaffoldPlugin(spec()).ok).toBe(true)
  })

  it('rejects invalid input before touching the disk', () => {
    expect(scaffoldPlugin(spec({ name: 'UPPER CASE' }))).toEqual({
      ok: false,
      error: 'invalid-name'
    })
    expect(scaffoldPlugin(spec({ name: '../escape' }))).toEqual({
      ok: false,
      error: 'invalid-name'
    })
    expect(scaffoldPlugin(spec({ version: 'latest' }))).toEqual({
      ok: false,
      error: 'invalid-version'
    })
    expect(scaffoldPlugin(spec({ extension: false, skill: false, prompt: false }))).toEqual({
      ok: false,
      error: 'no-resources'
    })
    expect(existsSync(path.join(dir, 'pi-demo'))).toBe(false)
  })

  it('rejects a missing parent directory', () => {
    expect(scaffoldPlugin(spec({ parentDir: path.join(dir, 'nope') }))).toEqual({
      ok: false,
      error: 'dir-missing'
    })
  })
})
