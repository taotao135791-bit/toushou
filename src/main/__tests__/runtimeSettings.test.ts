import { describe, it, expect } from 'vitest'
import { RuntimeSettings, PROVIDER_ID_PATTERN } from '../omp/settings/RuntimeSettings'
import { CliRunner } from '../omp/settings/OmpConfigCli'
import { RuntimeRpcClient } from '../omp/settings/RuntimeRpcClient'
import { CliInfo } from '../../shared/types'

/**
 * RuntimeSettings with fully injected runner + probe spawner — no real omp
 * process, no real config files. Verifies profile dispatch, the bootstrap
 * placeholder mask, and read-after-write semantics against the OFFICIAL
 * current-OMP config schema (modelRoles.default / defaultThinkingLevel /
 * skills.enableAgentsUser — verified 17.2.12).
 */

const OMP_CLI: CliInfo = { command: 'omp', path: '/usr/local/bin/omp', available: true }
const PI_CLI: CliInfo = { command: 'pi', path: '/usr/local/bin/pi', available: true }

interface ProbeScript {
  providers?: { id: string; name: string; available: boolean; authenticated: boolean }[]
  probeFails?: boolean
  bootstrap?: boolean
}

function fakeProbe(script: ProbeScript) {
  const spawnProbe: typeof RuntimeRpcClient.spawnWithBootstrap = async () => {
    if (script.probeFails) return null
    const client = {
      query: async (cmd: Record<string, unknown>) => {
        if (cmd.type === 'get_login_providers') {
          return {
            type: 'response',
            command: 'get_login_providers',
            success: true,
            data: { providers: script.providers ?? [] }
          }
        }
        return null
      },
      respond: () => true,
      kill: () => {}
    }
    return { client: client as unknown as RuntimeRpcClient, bootstrap: script.bootstrap === true }
  }
  return spawnProbe
}

type FakeEntry = { ok?: boolean; stdout?: string } | ((args: string[]) => { ok?: boolean; stdout?: string })

function fakeRunner(map: Record<string, FakeEntry>) {
  const calls: string[][] = []
  const run: CliRunner = async (args) => {
    calls.push(args)
    const hit = map[args.join(' ')]
    if (!hit) return { ok: false, stdout: '', stderr: 'unscripted' }
    const resolved = typeof hit === 'function' ? hit(args) : hit
    return { ok: resolved.ok !== false, stdout: resolved.stdout ?? '', stderr: '' }
  }
  return { run, calls }
}

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', available: true, authenticated: true },
  { id: 'openai', name: 'OpenAI', available: true, authenticated: false }
]

function modelRoles(value: Record<string, string>): string {
  return JSON.stringify({ key: 'modelRoles', value, type: 'record' })
}

describe('RuntimeSettings · current profile overview', () => {
  it('reads default model from modelRoles.default, never enabledModels', async () => {
    const { run } = fakeRunner({
      'config get modelRoles --json': {
        stdout: modelRoles({ default: 'deepseek/deepseek-v4-pro', smol: 'x/y' })
      },
      'config get defaultThinkingLevel --json': {
        stdout: JSON.stringify({ key: 'defaultThinkingLevel', value: 'high' })
      },
      'config get skills.enableAgentsUser --json': {
        stdout: JSON.stringify({ key: 'skills.enableAgentsUser', value: false })
      }
    })
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: run,
      spawnProbe: fakeProbe({ providers: PROVIDERS })
    })
    const overview = await svc.getOverview()
    expect(overview.profile).toBe('current')
    expect(overview.providers).toEqual(PROVIDERS)
    expect(overview.modelState).toEqual({
      defaultModel: 'deepseek/deepseek-v4-pro',
      defaultModelExplicit: true,
      defaultThinkingLevel: 'high'
    })
    expect(overview.machineSkillsState).toBe('disabled')
    expect(overview.capabilities.defaultModelConfig).toBe('supported')
  })

  it('missing modelRoles.default falls back to automatic, never enabledModels[0]', async () => {
    const { run } = fakeRunner({
      'config get modelRoles --json': { stdout: modelRoles({}) },
      'config get defaultThinkingLevel --json': {
        stdout: JSON.stringify({ key: 'defaultThinkingLevel', value: 'medium' })
      },
      'config get skills.enableAgentsUser --json': {
        stdout: JSON.stringify({ key: 'skills.enableAgentsUser', value: true })
      }
    })
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: run,
      spawnProbe: fakeProbe({ providers: PROVIDERS })
    })
    const overview = await svc.getOverview()
    expect(overview.modelState.defaultModel).toBe('')
    expect(overview.modelState.defaultModelExplicit).toBe(false)
  })

  it('reports machine skills unknown when the read-back is non-boolean', async () => {
    const { run } = fakeRunner({
      'config get modelRoles --json': { stdout: modelRoles({}) },
      'config get defaultThinkingLevel --json': {
        stdout: JSON.stringify({ key: 'defaultThinkingLevel', value: 'auto' })
      },
      // missing value key
      'config get skills.enableAgentsUser --json': {
        stdout: JSON.stringify({ key: 'skills.enableAgentsUser' })
      }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    const overview = await svc.getOverview()
    expect(overview.machineSkillsState).toBe('unknown')
    expect(overview.capabilities.machineSkillsConfig).toBe('supported')
  })

  it('masks the bootstrap placeholder provider as not authenticated', async () => {
    const { run } = fakeRunner({})
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: run,
      spawnProbe: fakeProbe({ providers: PROVIDERS, bootstrap: true })
    })
    const overview = await svc.getOverview()
    expect(overview.providers.find((p) => p.id === 'deepseek')?.authenticated).toBe(false)
    expect(overview.providers.find((p) => p.id === 'openai')?.authenticated).toBe(false)
  })

  it('reports providers unknown (never a fake verdict) when runtime AND registry fail', async () => {
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: fakeRunner({}).run,
      spawnProbe: fakeProbe({ probeFails: true })
    })
    const overview = await svc.getOverview()
    expect(overview.capabilities.providers).toBe('unknown')
    expect(overview.capabilities.nativeLogin).toBe('unknown')
    expect(overview.providers).toEqual([])
  })

  it('caches the overview and force-refreshes', async () => {
    const probe = fakeProbe({ providers: PROVIDERS })
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: fakeRunner({}).run,
      spawnProbe: probe
    })
    const first = await svc.getOverview()
    const second = await svc.getOverview()
    expect(second).toBe(first)
    const third = await svc.getOverview(true)
    expect(third).not.toBe(first)
  })
})

describe('RuntimeSettings · provider list from the CLI registry', () => {
  // `omp auth-broker list --json` — pure CLI, no runtime spawn, no
  // credentials: the dropdown's stable source even when the probe dies.
  const REGISTRY = JSON.stringify([
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'openai', name: 'OpenAI' }
  ])

  it('keeps the provider list when the probe fails (registry is the source)', async () => {
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: fakeRunner({ 'auth-broker list --json': { stdout: REGISTRY } }).run,
      spawnProbe: fakeProbe({ probeFails: true })
    })
    const overview = await svc.getOverview()
    expect(overview.providers).toEqual([
      { id: 'deepseek', name: 'DeepSeek', available: true, authenticated: false },
      { id: 'openai', name: 'OpenAI', available: true, authenticated: false }
    ])
    expect(overview.capabilities.providers).toBe('supported')
    expect(overview.capabilities.nativeLogin).toBe('unknown')
  })

  it('marks authenticated from `omp models` when the probe is unusable', async () => {
    const { run } = fakeRunner({
      'auth-broker list --json': { stdout: REGISTRY },
      // Credential-filtered: a provider with models listed necessarily has
      // credentials — the honest authenticated fallback without a probe.
      'models --json': {
        stdout: JSON.stringify({ models: [{ provider: 'deepseek', id: 'deepseek-v4-flash' }] })
      }
    })
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: run,
      spawnProbe: fakeProbe({ probeFails: true })
    })
    const overview = await svc.getOverview()
    expect(overview.providers.find((p) => p.id === 'deepseek')?.authenticated).toBe(true)
    expect(overview.providers.find((p) => p.id === 'openai')?.authenticated).toBe(false)
  })

  it('probe success layers authenticated onto registry identity', async () => {
    const { run } = fakeRunner({ 'auth-broker list --json': { stdout: REGISTRY } })
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: run,
      spawnProbe: fakeProbe({ providers: PROVIDERS })
    })
    const overview = await svc.getOverview()
    expect(overview.providers).toEqual([
      { id: 'deepseek', name: 'DeepSeek', available: true, authenticated: true },
      { id: 'openai', name: 'OpenAI', available: true, authenticated: false }
    ])
    expect(overview.capabilities.nativeLogin).toBe('supported')
  })

  it('keeps masking the bootstrap placeholder when the registry is the source', async () => {
    const { run } = fakeRunner({ 'auth-broker list --json': { stdout: REGISTRY } })
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: run,
      spawnProbe: fakeProbe({ providers: PROVIDERS, bootstrap: true })
    })
    const overview = await svc.getOverview()
    expect(overview.providers.find((p) => p.id === 'deepseek')?.authenticated).toBe(false)
    expect(overview.providers.find((p) => p.id === 'openai')?.authenticated).toBe(false)
  })

  it('appends probe-only providers after the registry entries', async () => {
    const { run } = fakeRunner({ 'auth-broker list --json': { stdout: REGISTRY } })
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: run,
      spawnProbe: fakeProbe({
        providers: [
          ...PROVIDERS,
          { id: 'extension-x', name: 'Extension X', available: true, authenticated: true }
        ]
      })
    })
    const overview = await svc.getOverview()
    expect(overview.providers.map((p) => p.id)).toEqual(['deepseek', 'openai', 'extension-x'])
    expect(overview.providers.at(-1)?.authenticated).toBe(true)
  })
})

describe('RuntimeSettings · current profile writes (read-after-write)', () => {
  it('setDefaultModel writes modelRoles.default and preserves other roles', async () => {
    let roles: Record<string, string> = { default: 'a/b', smol: 'x/y', slow: 'z/w' }
    const { run, calls } = fakeRunner({
      'config get modelRoles --json': () => ({ stdout: modelRoles(roles) }),
      'config set modelRoles {"default":"d/e","smol":"x/y","slow":"z/w"} --json': () => {
        roles = { default: 'd/e', smol: 'x/y', slow: 'z/w' }
        return { stdout: '{}' }
      }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    const r = await svc.setDefaultModel('d/e')
    expect(r.ok).toBe(true)
    const setCall = calls.find((c) => c[1] === 'set')
    expect(setCall?.[2]).toBe('modelRoles')
    expect(JSON.parse(setCall?.[3] ?? '{}')).toEqual({
      default: 'd/e',
      smol: 'x/y',
      slow: 'z/w'
    })
    expect(calls.some((c) => c[1] === 'set' && c[2] === 'enabledModels')).toBe(false)
  })

  it('setDefaultModel fails when the runtime does not confirm modelRoles.default', async () => {
    // The runtime silently drops the write: read-back still shows no default.
    const { run } = fakeRunner({
      'config get modelRoles --json': () => ({ stdout: modelRoles({}) }),
      'config set modelRoles {"default":"d/e"} --json': { stdout: '{}' }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    const r = await svc.setDefaultModel('d/e')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/did not confirm/)
  })

  it("setDefaultModel('') drops only default, preserving unrelated roles", async () => {
    let roles: Record<string, string> = { default: 'a/b', smol: 'x/y' }
    const { run } = fakeRunner({
      'config get modelRoles --json': () => ({ stdout: modelRoles(roles) }),
      'config set modelRoles {"smol":"x/y"} --json': () => {
        roles = { smol: 'x/y' }
        return { stdout: '{}' }
      }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    const r = await svc.setDefaultModel('')
    expect(r.ok).toBe(true)
  })

  it('setDefaultThinking verifies the level (auto is a legal config value)', async () => {
    const { run } = fakeRunner({
      'config set defaultThinkingLevel auto --json': { stdout: '{}' },
      'config get defaultThinkingLevel --json': {
        stdout: JSON.stringify({ key: 'defaultThinkingLevel', value: 'auto' })
      }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    expect((await svc.setDefaultThinking('auto')).ok).toBe(true)
  })

  it('logout uses auth-broker and fails when the credential persists', async () => {
    const { run, calls } = fakeRunner({
      'auth-broker logout deepseek': { stdout: 'Logged out' }
    })
    const svc = new RuntimeSettings({
      cli: OMP_CLI,
      runner: run,
      spawnProbe: fakeProbe({ providers: PROVIDERS })
    })
    const r = await svc.logout('deepseek')
    expect(calls.some((c) => c.join(' ').startsWith('auth-broker logout deepseek'))).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/still present/)
  })

  it('rejects invalid provider ids', async () => {
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: fakeRunner({}).run, spawnProbe: fakeProbe({}) })
    expect((await svc.logout('deep seek; rm -rf /')).ok).toBe(false)
    expect(PROVIDER_ID_PATTERN.test('deepseek')).toBe(true)
    expect(PROVIDER_ID_PATTERN.test('zai-coding-plan')).toBe(true)
    expect(PROVIDER_ID_PATTERN.test('-bad')).toBe(false)
  })
})

describe('RuntimeSettings · model catalog', () => {
  it('parses omp models --json including per-model thinking levels', async () => {
    const { run } = fakeRunner({
      'models --json': {
        stdout: JSON.stringify({
          models: [
            {
              provider: 'deepseek',
              id: 'deepseek-v4-flash',
              selector: 'deepseek/deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              contextWindow: 1000000,
              reasoning: true,
              thinking: ['low', 'high', 'max']
            }
          ]
        })
      }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    const models = await svc.listModels()
    expect(models).toHaveLength(1)
    expect(models[0].selector).toBe('deepseek/deepseek-v4-flash')
    expect(models[0].thinking).toEqual(['low', 'high', 'max'])
    expect(models[0].reasoning).toBe(true)
  })

  it('returns an empty catalog on CLI failure without throwing', async () => {
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: fakeRunner({}).run, spawnProbe: fakeProbe({}) })
    expect(await svc.listModels()).toEqual([])
  })
})

describe('RuntimeSettings · legacy profile', () => {
  it('reports the legacy profile with file-based capabilities', async () => {
    const svc = new RuntimeSettings({ cli: PI_CLI, runner: fakeRunner({}).run })
    const overview = await svc.getOverview()
    expect(overview.profile).toBe('legacy')
    expect(overview.capabilities.nativeLogin).toBe('unsupported')
    expect(overview.capabilities.providers).toBe('supported')
    expect(overview.machineSkillsState).toBe('unknown')
  })

  it('refuses current-profile writes on the legacy profile', async () => {
    const svc = new RuntimeSettings({ cli: PI_CLI, runner: fakeRunner({}).run })
    expect((await svc.setDefaultModel('a/b')).ok).toBe(false)
    expect((await svc.setDefaultThinking('max')).ok).toBe(false)
    expect((await svc.logout('deepseek')).ok).toBe(false)
  })
})

describe('RuntimeSettings · machine skills strict verification', () => {
  it('write success + read-back missing → failure, not truthiness', async () => {
    const { run } = fakeRunner({
      'config set skills.enableAgentsUser false --json': { stdout: '{}' },
      'config get skills.enableAgentsUser --json': {
        stdout: JSON.stringify({ key: 'skills.enableAgentsUser' })
      }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    expect((await svc.setMachineSkills(false)).ok).toBe(false)
  })

  it('write success + read-back wrong value → failure', async () => {
    const { run } = fakeRunner({
      'config set skills.enableAgentsUser false --json': { stdout: '{}' },
      'config get skills.enableAgentsUser --json': {
        stdout: JSON.stringify({ key: 'skills.enableAgentsUser', value: true })
      }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    expect((await svc.setMachineSkills(false)).ok).toBe(false)
  })

  it('consecutive mutations are serialized (write-verify pairs never interleave)', async () => {
    const order: string[] = []
    const run = async (args: string[]) => {
      order.push(args.join(' '))
      const key = args.join(' ')
      if (key === 'config set defaultThinkingLevel high --json') return { ok: true, stdout: '{}', stderr: '' }
      if (key === 'config set defaultThinkingLevel max --json') return { ok: true, stdout: '{}', stderr: '' }
      if (key === 'config get defaultThinkingLevel --json') {
        const lastSet = [...order].reverse().find((o) => o.startsWith('config set defaultThinkingLevel'))
        const value = lastSet?.endsWith(' max --json') ? 'max' : 'high'
        return { ok: true, stdout: JSON.stringify({ key: 'defaultThinkingLevel', value }), stderr: '' }
      }
      return { ok: false, stdout: '', stderr: 'unscripted' }
    }
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    const [a, b] = await Promise.all([svc.setDefaultThinking('high'), svc.setDefaultThinking('max')])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const sets = order.map((o, i) => ({ o, i })).filter((x) => x.o.startsWith('config set'))
    const gets = order.map((o, i) => ({ o, i })).filter((x) => x.o.startsWith('config get'))
    expect(sets).toHaveLength(2)
    expect(gets).toHaveLength(2)
    expect(gets[0].i).toBe(sets[0].i + 1)
    expect(sets[1].i).toBe(gets[0].i + 1)
    expect(gets[1].i).toBe(sets[1].i + 1)
  })
})

describe('RuntimeSettings · multi-slash selector safety', () => {
  it('round-trips openrouter/vendor/model selectors through modelRoles.default', async () => {
    const selector = 'openrouter/deepseek/deepseek-v4-flash-0731'
    let roles: Record<string, string> = {}
    const { run, calls } = fakeRunner({
      'config get modelRoles --json': () => ({ stdout: modelRoles(roles) }),
      [`config set modelRoles {"default":"${selector}"} --json`]: () => {
        roles = { default: selector }
        return { stdout: '{}' }
      }
    })
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    expect((await svc.setDefaultModel(selector)).ok).toBe(true)
    const setCall = calls.find((c) => c[1] === 'set')
    expect(JSON.parse(setCall?.[3] ?? '{}').default).toBe(selector)
  })

  it('rejects unsafe selectors before any CLI call', async () => {
    const { run, calls } = fakeRunner({})
    const svc = new RuntimeSettings({ cli: OMP_CLI, runner: run, spawnProbe: fakeProbe({}) })
    expect((await svc.setDefaultModel('-rf')).ok).toBe(false)
    expect((await svc.setDefaultModel('a\0b')).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})