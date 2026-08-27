import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// piSettings.ts imports ./omp for defaultPiAgentDir's CLI detection — the
// tests always pass an explicit dir, so stub it out electron-free.
vi.mock('../omp', () => ({
  detectCli: () => ({ command: 'pi', path: '/usr/local/bin/pi', available: true }),
  executableSearchDirs: () => []
}))

import {
  getModelConfig,
  setModelConfig,
  setApiKey,
  clearApiKey,
  listAuthProviders,
  readPiSettings,
  syncMachineSkills
} from '../piSettings'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-pi-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, name), 'utf-8'))
}

describe('getModelConfig', () => {
  it('returns defaults when no settings file exists', () => {
    const cfg = getModelConfig(dir)
    expect(cfg).toEqual({
      defaultProvider: '',
      defaultModel: '',
      defaultThinkingLevel: '',
      projectTrust: 'ask',
      authProviders: []
    })
  })

  it('ignores unknown thinking levels and trust modes', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ defaultThinkingLevel: 'ludicrous', defaultProjectTrust: 'yolo' })
    )
    const cfg = getModelConfig(dir)
    expect(cfg.defaultThinkingLevel).toBe('')
    expect(cfg.projectTrust).toBe('ask')
  })
})

describe('setModelConfig', () => {
  it('writes provider/model/thinking and preserves other keys', () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages: ['npm:x'] }))
    const result = setModelConfig(
      { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-5', defaultThinkingLevel: 'high' },
      dir
    )
    expect(result.ok).toBe(true)
    const settings = readJson('settings.json')
    expect(settings.defaultProvider).toBe('anthropic')
    expect(settings.defaultModel).toBe('claude-sonnet-4-5')
    expect(settings.defaultThinkingLevel).toBe('high')
    expect(settings.packages).toEqual(['npm:x'])
  })

  it('deletes keys when the value is an empty string', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'x' })
    )
    setModelConfig({ defaultProvider: '', defaultModel: '' }, dir)
    const settings = readJson('settings.json')
    expect('defaultProvider' in settings).toBe(false)
    expect('defaultModel' in settings).toBe(false)
  })

  it('rejects invalid trust modes', () => {
    const result = setModelConfig({ projectTrust: 'sometimes' as never }, dir)
    expect(result.ok).toBe(false)
  })
})

describe('api keys', () => {
  it('stores a key with api_key type and 0600 permissions', () => {
    const result = setApiKey('anthropic', 'sk-test-123', dir)
    expect(result.ok).toBe(true)
    const auth = readJson('auth.json')
    expect(auth.anthropic).toEqual({ type: 'api_key', key: 'sk-test-123' })
    expect(statSync(path.join(dir, 'auth.json')).mode & 0o777).toBe(0o600)
    expect(listAuthProviders(dir)).toEqual(['anthropic'])
  })

  it('merges into an existing auth file without touching other providers', () => {
    writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'sk-openai' } })
    )
    setApiKey('anthropic', 'sk-ant', dir)
    const auth = readJson('auth.json')
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-openai' })
    expect(auth.anthropic).toEqual({ type: 'api_key', key: 'sk-ant' })
  })

  it('refuses to overwrite OAuth credentials', () => {
    writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'oauth', access: 'tok', refresh: 'ref' } })
    )
    const result = setApiKey('anthropic', 'sk-ant', dir)
    expect(result.ok).toBe(false)
    expect(readJson('auth.json').anthropic).toEqual({ type: 'oauth', access: 'tok', refresh: 'ref' })
  })

  it('rejects invalid provider ids and empty keys', () => {
    expect(setApiKey('Anthropic!', 'sk-x', dir).ok).toBe(false)
    expect(setApiKey('anthropic', '   ', dir).ok).toBe(false)
  })

  it('clearApiKey removes only the target provider', () => {
    writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'api_key', key: 'a' },
        openai: { type: 'api_key', key: 'b' }
      })
    )
    expect(clearApiKey('anthropic', dir).ok).toBe(true)
    const auth = readJson('auth.json')
    expect('anthropic' in auth).toBe(false)
    expect(auth.openai).toEqual({ type: 'api_key', key: 'b' })
    expect(listAuthProviders(dir)).toEqual(['openai'])
    // clearing twice is a no-op success
    expect(clearApiKey('anthropic', dir).ok).toBe(true)
  })
})

describe('readPiSettings', () => {
  it('returns an empty object for a missing or corrupt file', () => {
    expect(readPiSettings(dir)).toEqual({})
    writeFileSync(path.join(dir, 'settings.json'), '{broken')
    expect(readPiSettings(dir)).toEqual({})
  })
})

describe('syncMachineSkills', () => {
  let skillsDir: string

  beforeEach(() => {
    skillsDir = mkdtempSync(path.join(tmpdir(), 'omp-machine-skills-'))
    mkdirSync(path.join(skillsDir, 'skill-a'))
    mkdirSync(path.join(skillsDir, 'skill-b'))
    mkdirSync(path.join(skillsDir, '.hidden'))
    writeFileSync(path.join(skillsDir, 'a-file.txt'), 'not a skill')
  })

  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true })
  })

  it('writes !name exclusions for every skill dir when disabled', () => {
    const excluded = syncMachineSkills(false, dir, skillsDir)
    expect(excluded).toEqual(['skill-a', 'skill-b'])
    expect(readJson('settings.json').skills).toEqual(['!skill-a', '!skill-b'])
  })

  it('preserves user-written overrides alongside managed exclusions', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ skills: ['!other-agent', 'my-skill'] })
    )
    syncMachineSkills(false, dir, skillsDir)
    expect(readJson('settings.json').skills).toEqual([
      '!other-agent',
      'my-skill',
      '!skill-a',
      '!skill-b'
    ])
  })

  it('removes exactly the managed exclusions when re-enabled', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ skills: ['!skill-a', '!skill-b', '!other-agent', 42] })
    )
    const excluded = syncMachineSkills(true, dir, skillsDir)
    expect(excluded).toEqual([])
    // 42 is dropped by the string filter; the user pattern survives
    expect(readJson('settings.json').skills).toEqual(['!other-agent'])
  })

  it('deletes the skills key when nothing remains', () => {
    syncMachineSkills(false, dir, skillsDir)
    syncMachineSkills(true, dir, skillsDir)
    expect('skills' in readJson('settings.json')).toBe(false)
  })

  it('is a no-op when no machine skills exist', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'omp-no-skills-'))
    try {
      expect(syncMachineSkills(false, dir, empty)).toEqual([])
      expect('skills' in (readPiSettings(dir) as Record<string, unknown>)).toBe(false)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
