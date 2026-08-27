import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { PluginScaffoldSpec } from '../types'
import {
  isValidPackageName,
  isValidVersion,
  planPluginFiles,
  unscopedName,
  validatePluginSpec
} from '../pluginScaffold'

function spec(overrides: Partial<PluginScaffoldSpec> = {}): PluginScaffoldSpec {
  return {
    name: 'pi-demo',
    description: 'demo package',
    version: '0.1.0',
    parentDir: '/tmp/parent',
    extension: true,
    skill: true,
    prompt: true,
    template: 'blank',
    ...overrides
  }
}

describe('isValidPackageName', () => {
  it('accepts plain and scoped lowercase npm names', () => {
    expect(isValidPackageName('pi-my-tool')).toBe(true)
    expect(isValidPackageName('a')).toBe(true)
    expect(isValidPackageName('@you/pi-tool')).toBe(true)
  })

  it('rejects anything else', () => {
    for (const bad of [
      '',
      'Pi-Tool',
      'has space',
      'pi_tool',
      '../escape',
      '/abs',
      '@scope/',
      '@scope',
      'a/b/c',
      '-leading'
    ]) {
      expect(isValidPackageName(bad)).toBe(false)
    }
  })
})

describe('isValidVersion', () => {
  it('accepts semver', () => {
    expect(isValidVersion('0.1.0')).toBe(true)
    expect(isValidVersion('1.2.3-beta.1')).toBe(true)
  })

  it('rejects non-semver', () => {
    expect(isValidVersion('latest')).toBe(false)
    expect(isValidVersion('1.0')).toBe(false)
    expect(isValidVersion('')).toBe(false)
  })
})

describe('unscopedName', () => {
  it('strips the npm scope', () => {
    expect(unscopedName('pi-demo')).toBe('pi-demo')
    expect(unscopedName('@you/pi-demo')).toBe('pi-demo')
  })
})

describe('validatePluginSpec', () => {
  it('accepts a complete spec', () => {
    expect(validatePluginSpec(spec())).toBeNull()
  })

  it('flags each invalid field with a stable code', () => {
    expect(validatePluginSpec(spec({ name: 'NOPE' }))).toBe('invalid-name')
    expect(validatePluginSpec(spec({ version: 'x' }))).toBe('invalid-version')
    expect(validatePluginSpec(spec({ description: '  ' }))).toBe('invalid-spec')
    expect(validatePluginSpec(spec({ extension: false, skill: false, prompt: false }))).toBe(
      'no-resources'
    )
    expect(validatePluginSpec(spec({ parentDir: ' ' }))).toBe('dir-missing')
  })
})

describe('planPluginFiles', () => {
  it('plans all resource files when everything is checked', () => {
    const files = planPluginFiles(spec())
    expect(files.map((f) => f.relativePath)).toEqual([
      'package.json',
      'README.md',
      'extensions/index.ts',
      'skills/pi-demo/SKILL.md',
      'prompts/pi-demo.md'
    ])
  })

  it('scopes the pi manifest and files list to the checked types', () => {
    const files = planPluginFiles(spec({ extension: false, skill: true, prompt: false }))
    expect(files.map((f) => f.relativePath)).toEqual([
      'package.json',
      'README.md',
      'skills/pi-demo/SKILL.md'
    ])
    const manifest = JSON.parse(files[0].content)
    expect(manifest.pi).toEqual({ skills: ['skills'] })
    expect(manifest.files).toEqual(['skills'])
    expect(manifest.peerDependencies).toBeUndefined()
  })

  it('emits a spec-conformant package.json', () => {
    const files = planPluginFiles(
      spec({ displayName: 'Demo Pack', author: 'Jane', name: '@you/pi-demo' })
    )
    const manifest = JSON.parse(files[0].content)
    expect(manifest).toMatchObject({
      name: '@you/pi-demo',
      version: '0.1.0',
      description: 'demo package',
      displayName: 'Demo Pack',
      author: 'Jane',
      license: 'MIT',
      pi: {
        extensions: ['extensions/index.ts'],
        skills: ['skills'],
        prompts: ['prompts']
      },
      files: ['extensions', 'skills', 'prompts'],
      peerDependencies: { '@mariozechner/pi-coding-agent': '*' }
    })
    expect(manifest.keywords).toContain('pi-package')
  })

  it('writes SKILL.md frontmatter and prompt skeleton from the unscoped name', () => {
    const files = planPluginFiles(spec({ name: '@you/pi-demo' }))
    const skill = files.find((f) => f.relativePath === 'skills/pi-demo/SKILL.md')
    expect(skill?.content).toContain('---\nname: pi-demo\ndescription: demo package\n---')
    const prompt = files.find((f) => f.relativePath === 'prompts/pi-demo.md')
    expect(prompt?.content).toContain('# pi-demo')
  })

  it('generates a compilable conservative extension per template', () => {
    const [blank, command, guard] = (['blank', 'command', 'tool-guard'] as const).map(
      (template) =>
        planPluginFiles(spec({ template, skill: false, prompt: false })).find(
          (f) => f.relativePath === 'extensions/index.ts'
        )!.content
    )
    for (const content of [blank, command, guard]) {
      expect(content).toContain("import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'")
      expect(content).toContain('export default function (pi: ExtensionAPI)')
      // transpileModule surfaces syntax errors without resolving imports
      const out = ts.transpileModule(content, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
        reportDiagnostics: true,
        fileName: 'index.ts'
      })
      expect(out.diagnostics ?? []).toEqual([])
    }
    expect(command).toContain("pi.registerCommand('pi-demo'")
    expect(command).toContain('ctx.ui.notify(')
    expect(guard).toContain("pi.on('tool_call'")
    expect(guard).toContain('block: true')
    expect(blank).not.toContain('registerCommand')
  })

  it('documents install options in the README', () => {
    const readme = planPluginFiles(spec())!.find((f) => f.relativePath === 'README.md')!.content
    expect(readme).toContain('pi install')
    expect(readme).toContain('npm:pi-demo')
  })
})
