import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { makeExecRunner, configGet, configSet, configReset } from '../../src/main/omp/settings/OmpConfigCli'
import { RuntimeSettings } from '../../src/main/omp/settings/RuntimeSettings'
import { createIsolatedOmpEnvironment, binaryAvailable, requireBinary, runOmp } from './isolated-runtime'

/**
 * Settings schema fidelity tests against the real current Oh My Pi binary —
 * always in an isolated temp environment. These verify the OFFICIAL config
 * semantics (modelRoles.default vs enabledModels, defaultThinkingLevel enum,
 * skills.enableAgentsUser state), never the developer's real config.
 *
 * Credential-free: no live provider inference happens here. `omp models --json`
 * and config read/write are local-only.
 */

const DEFAULT_THINKING_VALUES = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function makeService(iso: ReturnType<typeof createIsolatedOmpEnvironment>): RuntimeSettings {
  return new RuntimeSettings({
    cli: { command: 'omp', path: iso.ompBin, available: true },
    env: iso.env
  })
}

describe('current OMP — settings schema fidelity (isolated)', () => {
  let available = false
  let bin = 'omp'

  beforeAll(() => {
    bin = process.env.OMP_BIN || 'omp'
    available = binaryAvailable(bin)
    if (!available) requireBinary(bin)
    else console.log(`[test:omp] '${bin}' found — running settings schema suite`)
  })

  it('modelRoles is a record and nested keys are not CLI-addressable', () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      const record = runOmp(iso.env, bin, ['config', 'get', 'modelRoles', '--json'])
      expect(record).toContain('"modelRoles"')
      // Nested set is rejected as "Unknown setting" — official behavior.
      const nested = runOmp(iso.env, bin, ['config', 'set', 'modelRoles.default', 'x/y', '--json'])
      expect(nested).toMatch(/Unknown setting|error/i)
    } finally {
      iso.cleanup()
    }
  })

  it('defaultThinkingLevel enum accepts auto and rejects off', () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      expect(runOmp(iso.env, bin, ['config', 'set', 'defaultThinkingLevel', 'auto', '--json'])).toContain('auto')
      expect(runOmp(iso.env, bin, ['config', 'set', 'defaultThinkingLevel', 'off', '--json'])).toMatch(/Invalid value/i)
    } finally {
      iso.cleanup()
    }
  })

  it('enabledModels is preserved when Default Model changes (P0)', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      const run = makeExecRunner(bin, { env: iso.env, envMode: 'replace' })
      // Fixture: explicit initial state in the isolated env.
      expect(await configSet(run, 'enabledModels', ['model-a', 'model-b', 'model-c'])).toBe(true)
      expect(await configSet(run, 'modelRoles', { default: 'model-a' })).toBe(true)

      const svc = makeService(iso)
      const res = await svc.setDefaultModel('model-b')
      expect(res.ok).toBe(true)

      const enabled = await configGet(run, 'enabledModels')
      expect(enabled?.value).toEqual(['model-a', 'model-b', 'model-c'])

      const roles = await configGet(run, 'modelRoles')
      expect((roles?.value as Record<string, string>).default).toBe('model-b')
    } finally {
      iso.cleanup()
    }
  })

  it('modelRoles.default mutation preserves smol/slow (P0)', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      const run = makeExecRunner(bin, { env: iso.env, envMode: 'replace' })
      expect(await configSet(run, 'modelRoles', { default: 'A', smol: 'B', slow: 'C' })).toBe(true)

      const svc = makeService(iso)
      expect((await svc.setDefaultModel('D')).ok).toBe(true)

      const roles = (await configGet(run, 'modelRoles'))?.value as Record<string, string>
      expect(roles.default).toBe('D')
      expect(roles.smol).toBe('B')
      expect(roles.slow).toBe('C')
    } finally {
      iso.cleanup()
    }
  })

  it('missing modelRoles.default reads as automatic (never enabledModels[0])', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      const run = makeExecRunner(bin, { env: iso.env, envMode: 'replace' })
      expect(await configSet(run, 'enabledModels', ['model-a', 'model-b'])).toBe(true)
      expect(await configSet(run, 'modelRoles', {})).toBe(true)

      const overview = await makeService(iso).getOverview(true)
      expect(overview.modelState.defaultModel).toBe('')
      expect(overview.modelState.defaultModelExplicit).toBe(false)
    } finally {
      iso.cleanup()
    }
  })

  it('multi-slash selectors round-trip through config and read-back', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      const selectors = [
        'openrouter/deepseek/deepseek-v4-flash-0731',
        'openrouter/z-ai/glm-5.2',
        'foo/bar/baz/qux'
      ]
      for (const selector of selectors) {
        const run = makeExecRunner(bin, { env: iso.env, envMode: 'replace' })
        expect(await configSet(run, 'modelRoles', { default: selector })).toBe(true)
        const roles = (await configGet(run, 'modelRoles'))?.value as Record<string, string>
        expect(roles.default).toBe(selector)
      }
    } finally {
      iso.cleanup()
    }
  })

  it('default thinking covers the full verified config enum (write + read-back)', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      const svc = makeService(iso)
      for (const level of DEFAULT_THINKING_VALUES) {
        const res = await svc.setDefaultThinking(level as 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')
        expect(res.ok).toBe(true)
        const overview = await svc.getOverview(true)
        expect(overview.modelState.defaultThinkingLevel).toBe(level)
      }
    } finally {
      iso.cleanup()
    }
  })

  it('machine skills read-back maps to enabled/disabled/unknown, not a fake ON', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      const overview = await makeService(iso).getOverview(true)
      expect(['enabled', 'disabled', 'unknown']).toContain(overview.machineSkillsState)
    } finally {
      iso.cleanup()
    }
  })

  it('zero legacy writes: current OMP never creates auth.json/settings.json', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    try {
      const run = makeExecRunner(bin, { env: iso.env, envMode: 'replace' })
      const authBefore = existsSync(path.join(iso.agentDir, 'auth.json'))
      const settingsBefore = existsSync(path.join(iso.agentDir, 'settings.json'))

      await configSet(run, 'defaultThinkingLevel', 'high')
      await configReset(run, 'defaultThinkingLevel')
      await configSet(run, 'modelRoles', { default: 'x/y' })

      expect(existsSync(path.join(iso.agentDir, 'auth.json'))).toBe(authBefore)
      expect(existsSync(path.join(iso.agentDir, 'settings.json'))).toBe(settingsBefore)
    } finally {
      iso.cleanup()
    }
  })

  it('isolated env never matches the real user agent dir and has no credentials', () => {
    const iso = createIsolatedOmpEnvironment()
    try {
      expect(iso.agentDir).not.toBe(path.join(process.env.HOME ?? '', '.omp', 'agent'))
      const leaked = Object.keys(iso.env).filter((k) => /API_KEY|TOKEN/i.test(k))
      expect(leaked).toEqual([])
    } finally {
      iso.cleanup()
    }
  })
})