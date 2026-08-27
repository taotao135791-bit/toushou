import {
  CliInfo,
  DefaultThinkingLevel,
  MachineSkillsState,
  RuntimeCapabilities,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimeOverview,
  RuntimeProfile
} from '../../../shared/types'
import { detectCli } from '../OmpCapabilities'
import {
  authBrokerLogout,
  CliRunner,
  configGet,
  configReset,
  configSet,
  makeExecRunner,
  OmpConfigEntry
} from './OmpConfigCli'
import { BOOTSTRAP_PROVIDER_ID, RuntimeRpcClient } from './RuntimeRpcClient'
import { ProviderRegistry } from './ProviderRegistry'
import { isValidModelSelector, PROVIDER_ID_PATTERN, splitModelSelector } from './modelSelector'
import { switchModelSelector } from '../../../shared/modelSelector'

/**
 * Unified runtime-settings facade for the IPC layer: one API, two adapters.
 * The renderer never branches on `omp` vs `pi` — it reads profile +
 * capabilities from the overview and renders what the runtime supports.
 *
 * Current profile (omp): everything rides official interfaces —
 * `omp config` (typed config API), `omp auth-broker list` (the provider
 * registry — pure CLI, no runtime spawn, no credentials), RPC
 * get_login_providers / login, `omp auth-broker logout`. The provider LIST
 * comes from the registry so the dropdown survives a dead probe; the probe
 * only layers on authenticated state (with `omp models --json` as fallback).
 * Every write is read-after-write verified; a write that the runtime does
 * not confirm is a failure, never a fake "saved".
 *
 * Legacy profile (pi): the legacy file-based mechanisms keep working, just
 * reported through the same shape so the UI can label them honestly.
 */

// Official config keys, verified against current Oh My Pi 17.2.12
// (docs/settings-auth.md). `modelRoles` is a `record` type; nested fields
// are NOT addressable by key (omp config set modelRoles.default → "Unknown
// setting"), so a write must set the whole record while preserving the
// unrelated roles. `enabledModels` is a separate allow-list, never written
// by the GUI's default-model path.
const CONFIG_MODEL_ROLES = 'modelRoles'
const CONFIG_DEFAULT_THINKING = 'defaultThinkingLevel'
const CONFIG_MACHINE_SKILLS = 'skills.enableAgentsUser'

export interface RuntimeSettingsDeps {
  cli?: CliInfo
  runner?: CliRunner
  spawnProbe?: typeof RuntimeRpcClient.spawnWithBootstrap
  /** Provider-registry reader (tests inject a fresh/canned one). */
  registry?: ProviderRegistry
  /** Environment overrides for the runner + probe (test isolation). */
  env?: NodeJS.ProcessEnv
}

const OVERVIEW_TTL_MS = 15_000

function currentCapabilities(patch: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return {
    providers: 'unknown',
    nativeLogin: 'unknown',
    logout: 'unknown',
    modelCatalog: 'unknown',
    defaultModelConfig: 'unknown',
    defaultThinkingConfig: 'unknown',
    machineSkillsConfig: 'unknown',
    ...patch
  }
}

/** Truth value of `skills.enableAgentsUser` — never truthiness of `unknown`. */
function machineSkillsStateOf(entry: OmpConfigEntry | null): MachineSkillsState {
  if (!entry) return 'unknown'
  if (entry.value === true) return 'enabled'
  if (entry.value === false) return 'disabled'
  return 'unknown'
}

/**
 * Read `modelRoles.default`. Returns { selector, explicit } where explicit
 * is true only when the runtime has an actual non-empty string under the
 * `default` role — absence/empty falls back to the runtime's automatic
 * resolution, which must NOT be faked from the catalog or `enabledModels`.
 */
function defaultModelOf(entry: OmpConfigEntry | null): { selector: string; explicit: boolean } {
  const value = entry?.value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const def = (value as Record<string, unknown>).default
    if (typeof def === 'string' && def.length > 0) return { selector: def, explicit: true }
  }
  return { selector: '', explicit: false }
}

export class RuntimeSettings {
  private overviewCache: { at: number; overview: RuntimeOverview } | null = null
  private modelsCache: { at: number; models: RuntimeModelInfo[] } | null = null
  private readonly cli: CliInfo
  private readonly run: CliRunner
  private readonly spawnProbe: typeof RuntimeRpcClient.spawnWithBootstrap
  private readonly registry: ProviderRegistry

  constructor(deps: RuntimeSettingsDeps = {}) {
    this.cli = deps.cli ?? detectCli()
    this.run = deps.runner ?? makeExecRunner(this.cli.path ?? this.cli.command, { env: deps.env })
    this.spawnProbe = deps.spawnProbe ?? RuntimeRpcClient.spawnWithBootstrap
    this.registry = deps.registry ?? new ProviderRegistry()
    if (deps.env && !deps.spawnProbe) {
      // Isolate the login-provider probe too (never the developer's env),
      // while still honoring a fully injected probe in unit tests.
      this.spawnProbe = (cli, opts, events) =>
        RuntimeRpcClient.spawnWithBootstrap(cli, { ...opts, env: { ...(opts?.env ?? {}), ...deps.env } }, events)
    }
  }

  get profile(): RuntimeProfile {
    return this.cli.command === 'omp' ? 'current' : 'legacy'
  }

  /** Drop every cache (login/logout/writes/external changes/redetect). */
  invalidate(): void {
    this.overviewCache = null
    this.modelsCache = null
    this.registry.invalidate()
  }

  // ------------------------------------------------------------- overview

  async getOverview(force = false): Promise<RuntimeOverview> {
    if (!force && this.overviewCache && Date.now() - this.overviewCache.at < OVERVIEW_TTL_MS) {
      return this.overviewCache.overview
    }
    const overview =
      this.profile === 'current' ? await this.currentOverview() : this.legacyOverview()
    this.overviewCache = { at: Date.now(), overview }
    return overview
  }

  private async currentOverview(): Promise<RuntimeOverview> {
    const capabilities = currentCapabilities()

    // The provider LIST comes from the CLI registry (`auth-broker list`) —
    // a pure CLI read that never spawns the runtime and never needs
    // credentials, so the dropdown survives a dead/slow probe. The RPC probe
    // runs in parallel but only layers on authenticated state.
    const [registry, spawned] = await Promise.all([
      this.registry.list(this.run),
      this.spawnProbe(this.cli, { args: ['--no-extensions'] })
    ])
    capabilities.providers = registry ? 'supported' : 'unknown'

    let probeProviders: RuntimeOverview['providers'] | null = null
    let bootstrap = false
    if (spawned) {
      const res = await spawned.client.query({ type: 'get_login_providers' }, 10_000)
      spawned.client.kill()
      if (res?.success === true && res.data && typeof res.data === 'object') {
        capabilities.nativeLogin = 'supported'
        const raw = (res.data as { providers?: unknown }).providers
        if (Array.isArray(raw)) {
          probeProviders = raw
            .map((p) => {
              const o = p as { id?: unknown; name?: unknown; available?: unknown; authenticated?: unknown }
              return {
                id: typeof o.id === 'string' ? o.id : '',
                name: typeof o.name === 'string' ? o.name : '',
                available: o.available !== false,
                authenticated: o.authenticated === true
              }
            })
            .filter((p) => p.id)
        }
        bootstrap = spawned.bootstrap
      }
      // A spawned probe that answers badly (or times out) proves nothing —
      // nativeLogin stays 'unknown' rather than faking a verdict.
    }

    // Merge: registry identity/order first; probe-only extras appended so a
    // runtime-reported provider never silently vanishes. With the registry
    // unavailable the probe list (when present) is the fallback source.
    const probeById = new Map((probeProviders ?? []).map((p) => [p.id, p]))
    let providers: RuntimeOverview['providers'] = (registry ?? []).map((r) => {
      const probed = probeById.get(r.id)
      return {
        id: r.id,
        name: r.name,
        available: probed?.available ?? true,
        authenticated: probed?.authenticated === true
      }
    })
    if (probeProviders) {
      const known = new Set(providers.map((p) => p.id))
      for (const p of probeProviders) {
        if (!known.has(p.id)) providers.push(p)
      }
    }
    if (bootstrap) {
      // The bootstrap env key makes its provider look authenticated —
      // that is our placeholder, not real auth (read: fake-state guard).
      providers = providers.map((p) =>
        p.id === BOOTSTRAP_PROVIDER_ID ? { ...p, authenticated: false } : p
      )
    }
    if (!probeProviders && providers.length > 0) {
      // Probe unusable: `omp models --json` is credential-filtered, so a
      // provider whose models are listed necessarily has credentials.
      const withModels = new Set((await this.listModels()).map((m) => m.provider))
      providers = providers.map((p) =>
        withModels.has(p.id) ? { ...p, authenticated: true } : p
      )
    }

    const [modelRoles, defaultThinking, machineSkills] = await Promise.all([
      configGet(this.run, CONFIG_MODEL_ROLES),
      configGet(this.run, CONFIG_DEFAULT_THINKING),
      configGet(this.run, CONFIG_MACHINE_SKILLS)
    ])
    const { selector: defaultModel, explicit: defaultModelExplicit } = defaultModelOf(modelRoles)
    const modelState: RuntimeModelState = {
      defaultModel,
      defaultModelExplicit,
      defaultThinkingLevel:
        typeof defaultThinking?.value === 'string' ? defaultThinking.value : ''
    }
    capabilities.defaultModelConfig = modelRoles ? 'supported' : 'unsupported'
    capabilities.defaultThinkingConfig = defaultThinking ? 'supported' : 'unsupported'
    capabilities.machineSkillsConfig = machineSkills ? 'supported' : 'unsupported'
    capabilities.modelCatalog = 'supported' // omp models / get_available_models

    return {
      profile: 'current',
      capabilities,
      providers,
      modelState,
      machineSkillsState: machineSkillsStateOf(machineSkills)
    }
  }

  private legacyOverview(): RuntimeOverview {
    // Legacy profile: file-based auth/settings remain the mechanism. The UI
    // keeps using the legacy IPC for detail; the overview just reports the
    // profile and that native flows are file-based (not runtime-login).
    return {
      profile: 'legacy',
      capabilities: {
        providers: 'supported',
        nativeLogin: 'unsupported',
        logout: 'supported',
        modelCatalog: 'supported',
        defaultModelConfig: 'supported',
        defaultThinkingConfig: 'supported',
        machineSkillsConfig: 'supported'
      },
      providers: [],
      modelState: { defaultModel: '', defaultModelExplicit: false, defaultThinkingLevel: '' },
      // Legacy has no runtime-reported machine-skills state; present it as
      // unknown so the current-profile toggle logic cannot fake an ON state.
      machineSkillsState: 'unknown'
    }
  }

  // --------------------------------------------------------------- models

  /** Runtime model catalog (credential-filtered by the runtime itself). */
  async listModels(): Promise<RuntimeModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < OVERVIEW_TTL_MS) {
      return this.modelsCache.models
    }
    if (this.profile !== 'current') {
      // Legacy catalog rides the legacy registry/probe path (piModels).
      const { listAvailableModels } = await import('../../piModels')
      const models = (await listAvailableModels()).map((m) => ({
        provider: m.provider,
        id: m.id,
        selector: `${m.provider}/${m.id}`,
        name: m.name,
        reasoning: m.reasoning,
        thinking: []
      }))
      this.modelsCache = { at: Date.now(), models }
      return models
    }
    const res = await this.run(['models', '--json'])
    let models: RuntimeModelInfo[] = []
    if (res.ok) {
      try {
        const parsed = JSON.parse(res.stdout) as { models?: unknown }
        const raw = Array.isArray(parsed.models) ? parsed.models : []
        models = raw
          .map((m) => {
            const o = m as Record<string, unknown>
            const provider = typeof o.provider === 'string' ? o.provider : ''
            const id = typeof o.id === 'string' ? o.id : ''
            return {
              provider,
              id,
              selector:
                typeof o.selector === 'string' ? o.selector : provider && id ? `${provider}/${id}` : '',
              name: typeof o.name === 'string' ? o.name : id,
              contextWindow: typeof o.contextWindow === 'number' ? o.contextWindow : undefined,
              maxTokens: typeof o.maxTokens === 'number' ? o.maxTokens : undefined,
              reasoning: o.reasoning === true,
              thinking: Array.isArray(o.thinking)
                ? (o.thinking as unknown[]).filter((t): t is string => typeof t === 'string')
                : []
            }
          })
          .filter((m) => m.provider && m.id)
      } catch {
        models = []
      }
    }
    this.modelsCache = { at: Date.now(), models }
    return models
  }

  // ---------------------------------------------------------------- writes
  // Every write is read-after-write verified against the runtime, and all
  // mutations are serialized: rapid A→B changes cannot interleave their
  // write/read-back pairs, and a slow first write can never overwrite the
  // second one's confirmation.

  /** Serialize mutations through one chain so write+verify pairs never race. */
  private mutationChain: Promise<unknown> = Promise.resolve()

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(fn, fn)
    this.mutationChain = next.catch(() => {})
    return next
  }

  /**
   * Set the new-session default model via `modelRoles.default` — never
   * `enabledModels`. A target-field mutation preserves the other roles
   * (smol/slow/…) and the `enabledModels` allow-list untouched.
   */
  async setDefaultModel(selector: string): Promise<{ ok: boolean; error?: string }> {
    if (this.profile !== 'current') return { ok: false, error: 'legacy-profile' }
    if (selector && !isValidModelSelector(selector)) {
      return { ok: false, error: 'invalid model selector' }
    }
    return this.enqueue(async () => {
      if (selector) {
        const before = await configGet(this.run, CONFIG_MODEL_ROLES)
        const currentDefault = this.modelRolesRecord(before).default ?? ''
        // Preserve the role-level thinking override when the caller switches
        // only the model half (A:high → B:high, never silently dropping :high).
        const effective = switchModelSelector(currentDefault, selector)
        const merged = { ...this.modelRolesRecord(before), default: effective }
        if (!(await configSet(this.run, CONFIG_MODEL_ROLES, merged))) {
          return { ok: false, error: 'omp config set failed' }
        }
        const verify = await configGet(this.run, CONFIG_MODEL_ROLES)
        this.invalidate()
        const actual = this.modelRolesRecord(verify).default
        if (actual !== effective) {
          return {
            ok: false,
            error: `runtime did not confirm the change (got "${actual || 'unset'}")`
          }
        }
        return { ok: true }
      }
      // '' = reset to automatic resolution: drop only the `default` role.
      const before = await configGet(this.run, CONFIG_MODEL_ROLES)
      const { default: _drop, ...rest } = this.modelRolesRecord(before)
      if (!(await configSet(this.run, CONFIG_MODEL_ROLES, rest))) {
        return { ok: false, error: 'omp config reset failed' }
      }
      const verify = await configGet(this.run, CONFIG_MODEL_ROLES)
      this.invalidate()
      if (this.modelRolesRecord(verify).default !== undefined) {
        return { ok: false, error: 'runtime did not confirm the reset' }
      }
      return { ok: true }
    })
  }

  async setDefaultThinking(level: DefaultThinkingLevel | ''): Promise<{ ok: boolean; error?: string }> {
    if (this.profile !== 'current') return { ok: false, error: 'legacy-profile' }
    return this.enqueue(async () => {
      if (level) {
        if (!(await configSet(this.run, CONFIG_DEFAULT_THINKING, level))) {
          return { ok: false, error: 'omp config set failed' }
        }
        const verify = await configGet(this.run, CONFIG_DEFAULT_THINKING)
        const actual = verify?.value
        this.invalidate()
        // Exact match only.
        if (actual !== level) {
          return {
            ok: false,
            error: `runtime did not confirm the change (got "${typeof actual === 'string' ? actual : 'unset'}")`
          }
        }
        return { ok: true }
      }
      // '' = reset to the runtime default. Verification: the key must exist
      // afterwards with its (runtime-chosen) default value.
      if (!(await configReset(this.run, CONFIG_DEFAULT_THINKING))) {
        return { ok: false, error: 'omp config reset failed' }
      }
      const verify = await configGet(this.run, CONFIG_DEFAULT_THINKING)
      this.invalidate()
      if (typeof verify?.value !== 'string') {
        return { ok: false, error: 'runtime did not confirm the reset' }
      }
      return { ok: true }
    })
  }

  async setMachineSkills(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (this.profile !== 'current') return { ok: false, error: 'legacy-profile' }
    return this.enqueue(async () => {
      if (!(await configSet(this.run, CONFIG_MACHINE_SKILLS, enabled))) {
        return { ok: false, error: 'omp config set failed' }
      }
      const verify = await configGet(this.run, CONFIG_MACHINE_SKILLS)
      this.invalidate()
      // Exact boolean match only — missing/null/undefined is a failure,
      // never truthiness.
      if (verify?.value !== enabled) {
        return { ok: false, error: 'runtime did not confirm the change' }
      }
      return { ok: true }
    })
  }

  async logout(providerId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.profile !== 'current') return { ok: false, error: 'legacy-profile' }
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      return { ok: false, error: 'invalid provider id' }
    }
    return this.enqueue(async () => {
      if (!(await authBrokerLogout(this.run, providerId))) {
        return { ok: false, error: 'omp auth-broker logout failed' }
      }
      this.invalidate()
      // Read-after-write: the runtime must agree the credential is gone.
      const overview = await this.getOverview(true)
      const still = overview.providers.find((p) => p.id === providerId)
      if (still?.authenticated) {
        return { ok: false, error: 'credential still present (e.g. also set as an environment variable)' }
      }
      return { ok: true }
    })
  }

  /** Coerce a modelRoles entry to a plain record (never throw on bad shape). */
  private modelRolesRecord(entry: OmpConfigEntry | null): Record<string, string> {
    const value = entry?.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  }
}

// Re-export the single model-selector validator + provider-id shape so
// existing consumers keep a stable import surface (`./RuntimeSettings`)
// while the implementations live in a dedicated, shared module.
export { isValidModelSelector, splitModelSelector, PROVIDER_ID_PATTERN }
