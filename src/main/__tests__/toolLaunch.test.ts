import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Discovery is pure filesystem work; keep the CLI/electron-touching
// orchestrator out of the unit under test.
vi.mock('../packages', () => ({
  listPackages: vi.fn(async () => [])
}))

import { readToolManifest, scanPromptCommands, toolsFromPackageRoot } from '../toolLaunch'

const tempRoots: string[] = []

function makePackage(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tool-launch-'))
  tempRoots.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('readToolManifest', () => {
  it('reads name, displayName and description', () => {
    const dir = makePackage({
      'package.json': JSON.stringify({
        name: 'toushou-ads-toolkit',
        displayName: '谷歌广告文案工具',
        description: 'Google AC copy generator'
      })
    })
    expect(readToolManifest(dir)).toEqual({
      name: 'toushou-ads-toolkit',
      label: '谷歌广告文案工具',
      description: 'Google AC copy generator'
    })
  })

  it('falls back to the package name as label and drops empty strings', () => {
    const dir = makePackage({ 'package.json': JSON.stringify({ name: 'x' }) })
    expect(readToolManifest(dir)).toEqual({ name: 'x', label: 'x', description: undefined })
  })

  it('returns null without a usable manifest', () => {
    const dir = makePackage({ 'package.json': 'not json' })
    expect(readToolManifest(dir)).toBeNull()
    const empty = makePackage({})
    expect(readToolManifest(empty)).toBeNull()
  })
})

describe('scanPromptCommands', () => {
  it('maps prompt file base names to slash commands', () => {
    const dir = makePackage({
      'prompts/ads.md': '# ads',
      'prompts/board-design.md': '# board',
      'prompts/UPPER.md': '# upper'
    })
    expect(scanPromptCommands(dir)).toEqual(['/UPPER', '/ads', '/board-design'])
  })

  it('ignores non-markdown files, weird names, and a missing directory', () => {
    const dir = makePackage({
      'prompts/readme.txt': 'x',
      'prompts/has space.md': 'x',
      'prompts/.hidden.md': 'x'
    })
    expect(scanPromptCommands(dir)).toEqual([])
    expect(scanPromptCommands(makePackage({}))).toEqual([])
  })
})

describe('toolsFromPackageRoot', () => {
  it('produces one launchable tool per prompt command', () => {
    const dir = makePackage({
      'package.json': JSON.stringify({ name: 'pkg', displayName: 'Pkg' }),
      'prompts/ads.md': '# ads',
      'prompts/seo.md': '# seo'
    })
    expect(toolsFromPackageRoot(dir, 'bundled')).toEqual([
      { id: 'pkg:/ads', packageName: 'pkg', label: 'Pkg', command: '/ads', description: undefined, origin: 'bundled' },
      { id: 'pkg:/seo', packageName: 'pkg', label: 'Pkg', command: '/seo', description: undefined, origin: 'bundled' }
    ])
  })

  it('returns nothing for a package without prompts', () => {
    const dir = makePackage({ 'package.json': JSON.stringify({ name: 'pkg' }) })
    expect(toolsFromPackageRoot(dir, 'installed')).toEqual([])
  })
})
