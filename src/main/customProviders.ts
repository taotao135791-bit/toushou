import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import YAML from 'yaml'
import {
  CustomProviderError,
  CustomProviderDeleteResult,
  CustomProviderInfo,
  CustomProviderModelSpec,
  CustomProviderSaveResult,
  CustomProviderSpec,
  CustomProvidersListResult,
  RuntimeModelInfo,
  modelInputs
} from '../shared/types'
import { defaultPiAgentDir } from './piSettings'
import { detectCli } from './omp'
import { CliRunner, makeExecRunner } from './omp/settings/OmpConfigCli'
import { PROVIDER_ID_PATTERN } from './omp/settings/modelSelector'
import { listOmpModelCatalog } from './omp/settings/OmpModelCatalog'
import { findCustomCatalogModel, GENERIC_CUSTOM_PROVIDER_APIS, isCustomProviderApi, matchesCatalogEndpoint, modelTokenLimit } from '../shared/modelCatalog'
import { modelThinkingEfforts, NativeModelThinking } from './omp/modelThinking'

/**
 * Custom provider management via omp's official `~/.omp/agent/models.yml`
 * (docs/models.md, verified against omp 17.2.7). This is the opencode-style
 * escape hatch from the built-in provider registry: baseUrl + API key +
 * model list, straight into the runtime's own custom-provider file.
 *
 * Safety contract:
 * - The file has exactly ONE root key (`providers`); anything else is a
 *   shape error we report honestly instead of clobbering.
 * - Upserts preserve every other provider entry (full YAML parse → mutate →
 *   stringify round-trip, never string surgery).
 * - Writes are atomic (tmp + rename) and every save is verified by running
 *   `omp models --json`: omp drops the ENTIRE custom-provider set with
 *   "models.yml validation failed" when the schema is off, so a save the
 *   runtime does not recognize is rolled back to the pre-write bytes.
 *   When the CLI itself is unusable the verification degrades to file-level
 *   only (`verified: false`) — we never roll back on a broken probe.
 * - API keys never leave this module: `listCustomProviders` reports `hasKey`
 *   only.
 */

export interface CustomProvidersDeps {
  /** models.yml path; defaults to <piAgentDir>/models.yml (~/.omp/agent for omp). */
  modelsFile?: string
  /**
   * CLI runner for the post-write `omp models --json` verification. Pass
   * `null` to explicitly skip verification (degraded mode).
   */
  runner?: CliRunner | null
  /** Native model metadata for this provider (loaded from OMP by default). */
  modelCatalog?: RuntimeModelInfo[]
  /** fetch implementation for the live key check (tests inject a stub). */
  fetchImpl?: typeof fetch
}

const MAX_BASE_URL_LENGTH = 500
const MAX_API_KEY_LENGTH = 1000
const MAX_MODELS = 100
const MAX_MODEL_FIELD = 300

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

/** https for anything remote; plain http only for loopback servers. */
function isValidBaseUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_BASE_URL_LENGTH) return false
  if (/\s/.test(url) || CONTROL_RE.test(url)) return false
  if (/^https:\/\/[^\s/?#]+/.test(url)) return true
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?([/?#]|$)/i.test(url)) return true
  return false
}

function defaultModelsFile(): string {
  return path.join(defaultPiAgentDir(), 'models.yml')
}

function defaultRunner(): CliRunner | null {
  const cli = detectCli()
  if (!cli.available) return null
  // Verification may have to boot the provider catalog — slower than a
  // config read, so it gets its own 30s budget.
  return makeExecRunner(cli.path ?? cli.command, { timeoutMs: 30_000 })
}

type ModelsDoc = { providers: Record<string, unknown> }

interface ReadOk {
  ok: true
  /** Raw file bytes; null when the file does not exist. */
  raw: string | null
  doc: ModelsDoc
}

/** Read + parse models.yml. Missing file → empty doc; bad YAML/shape → honest error. */
function readModelsFile(file: string): ReadOk | { ok: false; error: 'parse' | 'read'; detail?: string } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, raw: null, doc: { providers: {} } }
    }
    return { ok: false, error: 'read', detail: err instanceof Error ? err.message : String(err) }
  }
  let parsed: unknown
  try {
    parsed = YAML.parse(raw)
  } catch (err) {
    return { ok: false, error: 'parse', detail: err instanceof Error ? err.message : String(err) }
  }
  if (parsed === null || parsed === undefined) {
    return { ok: true, raw, doc: { providers: {} } }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'parse', detail: 'models.yml root must be a mapping' }
  }
  const keys = Object.keys(parsed as Record<string, unknown>)
  if (keys.some((k) => k !== 'providers')) {
    return { ok: false, error: 'parse', detail: `models.yml may only have the root key "providers" (found: ${keys.join(', ')})` }
  }
  const providers = (parsed as Record<string, unknown>).providers
  if (providers === null || providers === undefined) {
    return { ok: true, raw, doc: { providers: {} } }
  }
  if (typeof providers !== 'object' || Array.isArray(providers)) {
    return { ok: false, error: 'parse', detail: 'models.yml "providers" must be a mapping' }
  }
  return { ok: true, raw, doc: { providers: providers as Record<string, unknown> } }
}

/** Atomic write (tmp + rename), same pattern as writePiSettings. */
function writeModelsFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    writeFileSync(tmp, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
  } finally {
    try { unlinkSync(tmp) } catch { /* The rename has already removed it. */ }
  }
}

/** Restore the exact pre-write state (bytes or absence). Best-effort. */
function restoreModelsFile(file: string, raw: string | null): void {
  try {
    if (raw === null) {
      unlinkSync(file)
    } else {
      writeModelsFile(file, raw)
    }
  } catch {
    // Rollback failure is reported via the save result, not thrown.
  }
}

/**
 * Structural sanitizer for IPC input: whitelist + re-type every field.
 * Semantic validation (patterns, ranges, mutual exclusion) happens again in
 * validateSpec — the two layers mirror sanitizeScaffoldSpec / scaffoldPlugin.
 */
export function sanitizeCustomProviderSpec(raw: unknown): CustomProviderSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (typeof s.id !== 'string' || typeof s.baseUrl !== 'string') return null
  if (!isCustomProviderApi(s.api)) return null
  const models: CustomProviderModelSpec[] = []
  if (Array.isArray(s.models)) {
    for (const m of s.models.slice(0, MAX_MODELS)) {
      if (!m || typeof m !== 'object') return null
      const o = m as Record<string, unknown>
      if (typeof o.id !== 'string') return null
      // name is optional — falls back to the id downstream; a non-string name is not.
      if (o.name !== undefined && typeof o.name !== 'string') return null
      const entry: CustomProviderModelSpec = {
        id: o.id,
        name: typeof o.name === 'string' ? o.name : ''
      }
      if (o.input !== undefined) {
        if (o.input === null) entry.input = null
        else {
          const input = modelInputs(o.input)
          if (!input) return null
          entry.input = input
        }
      }
      if (o.contextWindow !== undefined) {
        if (typeof o.contextWindow !== 'number' || !Number.isFinite(o.contextWindow)) return null
        entry.contextWindow = o.contextWindow
      }
      if (o.maxTokens !== undefined) {
        if (typeof o.maxTokens !== 'number' || !Number.isFinite(o.maxTokens)) return null
        entry.maxTokens = o.maxTokens
      }
      models.push(entry)
    }
  }
  return {
    id: s.id,
    baseUrl: s.baseUrl,
    api: s.api,
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : undefined,
    authNone: s.authNone === true,
    discovery: s.discovery === true,
    models
  }
}

/** Semantic validation; returns the failure code or null when clean. */
function validateSpec(spec: CustomProviderSpec, hasExistingKey: boolean): CustomProviderError | null {
  if (!PROVIDER_ID_PATTERN.test(spec.id)) return 'invalid-id'
  if (!isValidBaseUrl(spec.baseUrl)) return 'invalid-base-url'
  if (!isCustomProviderApi(spec.api)) return 'invalid-api'
  if (spec.api === 'google-generative-ai' && spec.authNone) return 'invalid-api-key'
  if (spec.api === 'google-generative-ai' && spec.discovery) return 'invalid-models'
  if (spec.apiKey !== undefined) {
    const key = spec.apiKey.trim()
    if (!key || key.length > MAX_API_KEY_LENGTH || CONTROL_RE.test(key)) return 'invalid-api-key'
  }
  if (!spec.authNone && spec.apiKey === undefined && !hasExistingKey) return 'invalid-api-key'
  if (spec.discovery && spec.models.length > 0) return 'invalid-models'
  if (!spec.discovery) {
    if (spec.models.length === 0) return 'invalid-models'
    for (const m of spec.models) {
      if (!m.id.trim() || m.id.length > MAX_MODEL_FIELD || CONTROL_RE.test(m.id)) return 'invalid-models'
      if (m.input != null && !modelInputs(m.input)) return 'invalid-models'
      if (m.name.length > MAX_MODEL_FIELD) return 'invalid-models'
      if (m.contextWindow !== undefined && !modelTokenLimit(m.contextWindow)) {
        return 'invalid-models'
      }
      if (m.maxTokens !== undefined && !modelTokenLimit(m.maxTokens)) {
        return 'invalid-models'
      }
    }
  }
  return null
}

type CapabilityFields = Pick<RuntimeModelInfo, 'input' | 'contextWindow' | 'maxTokens'>

export function catalogCorrection(stored: { input?: unknown; contextWindow?: unknown; maxTokens?: unknown }, native: CapabilityFields): CapabilityFields {
  const changes: CapabilityFields = {}
  if (native.input && (!Array.isArray(stored.input) || native.input.length !== stored.input.length ||
    native.input.some(input => !(stored.input as unknown[]).includes(input)))) changes.input = native.input
  if (native.contextWindow !== undefined && native.contextWindow !== stored.contextWindow) changes.contextWindow = native.contextWindow
  if (native.maxTokens !== undefined && native.maxTokens !== stored.maxTokens) changes.maxTokens = native.maxTokens
  return changes
}

/** Model-level transport overrides take precedence over the provider endpoint in OMP. */
function modelEndpoint(provider: { id: string; baseUrl: string; api: string }, model?: Record<string, unknown>) {
  return { id: provider.id,
    baseUrl: typeof model?.baseUrl === 'string' ? model.baseUrl : provider.baseUrl,
    api: typeof model?.api === 'string' ? model.api : provider.api }
}

/** Keep fields managed outside the GUI when editing the same endpoint. */
function buildEntry(spec: CustomProviderSpec, catalog: RuntimeModelInfo[], existingKey?: string, previous?: Record<string, unknown>): Record<string, unknown> {
  const endpoint = spec.baseUrl.trim().replace(/\/+$/, '')
  const nativeProvider = catalog.some(model => matchesCatalogEndpoint(model, spec))
  const sameEndpoint = previous !== undefined &&
    (previous.baseUrl === undefined ? nativeProvider : typeof previous.baseUrl === 'string' && previous.baseUrl.replace(/\/+$/, '') === endpoint) &&
    (previous.api === undefined ? nativeProvider : previous.api === spec.api)
  const entry: Record<string, unknown> = {
    ...(sameEndpoint ? previous : undefined),
    baseUrl: spec.baseUrl.trim(),
    api: spec.api
  }
  if (spec.authNone) {
    delete entry.apiKey
    entry.auth = 'none'
  } else {
    delete entry.auth
    entry.apiKey = spec.apiKey !== undefined ? spec.apiKey.trim() : existingKey
  }
  if (spec.discovery) {
    delete entry.models
    entry.discovery ??= { type: 'openai-models-list' }
  } else {
    delete entry.discovery
    const previousModels = sameEndpoint && Array.isArray(previous?.models) ? previous.models : []
    const overrides = mapping(entry.modelOverrides)
    if (overrides) entry.modelOverrides = { ...overrides }
    entry.models = spec.models.map((m) => {
      const id = m.id.trim()
      const previousModel = mapping(previousModels.find((model) => mapping(model)?.id === id))
      const native = findCustomCatalogModel(catalog, modelEndpoint(spec, previousModel), id)
      const preserved = m.input === undefined ? modelInputs(previousModel?.input) : undefined
      const out: Record<string, unknown> = {
        ...previousModel,
        id,
        name: m.name.trim() || id,
        reasoning: typeof previousModel?.reasoning === 'boolean' ? previousModel.reasoning : native?.reasoning ?? false,
        input: native?.input ?? m.input ?? preserved ?? ['text']
      }
      if (m.contextWindow === undefined) delete out.contextWindow
      else out.contextWindow = m.contextWindow
      if (m.maxTokens !== undefined) out.maxTokens = m.maxTokens
      if (native) {
        Object.assign(out, catalogCorrection(out, native))
        const override = overrides && Object.hasOwn(overrides, id) ? mapping(overrides[id]) : undefined
        if (override) {
          const correction = catalogCorrection(override, native)
          // An override with only unrelated fields already inherits the model declaration.
          const fields = Object.entries(correction).filter(([key]) => Object.hasOwn(override, key))
          if (fields.length) (entry.modelOverrides as Record<string, unknown>)[id] = { ...override, ...Object.fromEntries(fields) }
        }
      }
      return out
    })
  }
  return entry
}

/** The provider's models as `omp models --json` reports them. */
async function verifyWithRuntime(run: CliRunner, providerId: string): Promise<boolean | null> {
  const res = await run(['models', '--json'])
  if (!res.ok) return null // CLI unusable — caller degrades instead of rolling back
  try {
    const parsed = JSON.parse(res.stdout) as { models?: unknown }
    const models = Array.isArray(parsed.models) ? parsed.models : []
    return models.some(
      (m) => m && typeof m === 'object' && (m as Record<string, unknown>).provider === providerId
    )
  } catch {
    return null
  }
}

/**
 * Best-effort live key check against the provider's model-list endpoint.
 * Presence in `omp models --json` only proves a credential RESOLVED, not that
 * it works — a typo'd key would "save" and then fail every chat turn with a
 * 401. Only definitive rejections (401/403) fail the save; network errors and
 * providers without such an endpoint pass through (never a false negative).
 */
export async function liveKeyCheck(
  baseUrl: string,
  api: string,
  key: string,
  fetchImpl: typeof fetch = fetch
): Promise<'ok' | 'rejected' | 'unknown'> {
  if (!baseUrl || !key) return 'unknown'
  const clean = baseUrl.replace(/\/+$/, '')
  const targets: { url: string; headers: Record<string, string> }[] =
    api === 'anthropic-messages'
      ? [
          {
            url: `${clean.replace(/\/v1$/, '')}/v1/models`,
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          }
        ]
      : api === 'openai-completions' || api === 'openai-responses'
        ? [{ url: `${clean}/models`, headers: { authorization: `Bearer ${key}` } }]
        : []
  if (targets.length === 0) return 'unknown'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    const res = await fetchImpl(targets[0].url, { headers: targets[0].headers, signal: controller.signal })
    clearTimeout(timer)
    if (res.status === 401 || res.status === 403) return 'rejected'
    return 'ok'
  } catch {
    return 'unknown'
  }
}

// Read-modify-write + verify must never interleave between two saves.
let mutationChain: Promise<unknown> = Promise.resolve()

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn)
  mutationChain = next.catch(() => {})
  return next
}

function mapping(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Editing an anchored model must not silently change a different provider that reused it. */
function editableModelsDocument(raw: string | null) {
  const yaml = YAML.parseDocument(raw ?? 'providers: {}\n')
  YAML.visit(yaml, { Alias(_key, alias, ancestors) {
    const source = alias.resolve(yaml)
    if (!source || ancestors.includes(source)) throw new Error('Invalid models.yml alias')
    const copy = source.clone()
    if (!YAML.isNode(copy)) throw new Error('Unsupported models.yml alias')
    YAML.visit(copy, { Value(_key, value) { delete value.anchor } })
    return copy
  } })
  return yaml
}

/** The CLI has already read these limits. Only persist corrections for matching transports. */
export function repairCatalogModelCapabilities(candidates: readonly (RuntimeModelInfo & { discovered?: CapabilityFields })[], file: string): Promise<boolean> {
  if (candidates.length === 0) return Promise.resolve(false)
  return enqueue(async () => {
    try {
      if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return false
      const current = readModelsFile(file)
      if (!current.ok) return false
      const yaml = editableModelsDocument(current.raw)
      let changed = false
      for (const model of candidates) {
        if (!PROVIDER_ID_PATTERN.test(model.provider) || !model.api || !model.baseUrl) continue
        const config = mapping(current.doc.providers[model.provider])
        const rows = Array.isArray(config?.models) ? config.models : []
        const index = rows.findIndex(row => mapping(row)?.id === model.id)
        const row = mapping(rows[index])
        const provider = { id: model.provider,
          baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : model.baseUrl,
          api: typeof config?.api === 'string' ? config.api : model.api }
        if (!matchesCatalogEndpoint(model, modelEndpoint(provider, row))) continue
        // An exact native endpoint can be declared explicitly in models[], or be
        // a stock provider with a per-model override (including a key-only provider).
        const overrides = mapping(config?.modelOverrides)
        if (config?.modelOverrides !== undefined && !overrides) continue
        const rawOverride = overrides && Object.hasOwn(overrides, model.id) ? overrides[model.id] : undefined
        const override = mapping(rawOverride)
        if (rawOverride !== undefined && !override) continue
        const target = ['providers', model.provider]
        if (row) {
          for (const [key, value] of Object.entries(catalogCorrection(row, model))) {
            yaml.setIn([...target, 'models', index, key], value)
            changed = true
          }
        }
        for (const [key, value] of Object.entries(catalogCorrection(override ?? {}, model))) {
          if (!Object.hasOwn(override ?? {}, key)) {
            if (row) continue // The corrected model declaration already supplies this value.
            const discovered = model.discovered?.[key as keyof CapabilityFields]
            // Preserve newer live capabilities on native models. A stale manual setting
            // on a declared model or override is still reconciled to the exact catalog limit.
            if (typeof value === 'number' && typeof discovered === 'number' && discovered >= value) continue
            if (Array.isArray(value) && Array.isArray(discovered) && discovered.some(input => !value.includes(input))) continue
          }
          yaml.setIn([...target, 'modelOverrides', model.id, key], value)
          changed = true
        }
      }
      if (!changed) return false
      const latest = readModelsFile(file)
      if (!latest.ok || latest.raw !== current.raw) return false
      writeModelsFile(file, yaml.toString())
      return true
    } catch {
      return false
    }
  })
}

/** Backfill native reasoning metadata only for an exact same-provider catalog match. */
export function repairDiscoveredModelThinking(
  models: readonly RuntimeModelInfo[],
  capabilities: ReadonlyMap<string, NativeModelThinking>,
  file: string
): Promise<boolean> {
  const candidates = models.flatMap((model) => {
    if (!PROVIDER_ID_PATTERN.test(model.provider) || modelThinkingEfforts(model.thinking).length > 0) return []
    const thinking = capabilities.get(`${model.provider}/${model.id}`)
    return thinking ? [{ provider: model.provider, id: model.id, thinking }] : []
  })
  if (candidates.length === 0) return Promise.resolve(false)
  return enqueue(async () => {
    try {
      if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return false
      const current = readModelsFile(file)
      if (!current.ok) return false
      const yaml = editableModelsDocument(current.raw)
      let changed = false
      for (const { provider, id, thinking } of candidates) {
        const entry = current.doc.providers[provider]
        const config = mapping(entry)
        if ((entry !== undefined && !config) || config?.baseUrl !== undefined || config?.api !== undefined) continue
        if (Array.isArray(config?.models) && config.models.some((model) => mapping(model)?.id === id)) continue
        const overrides = mapping(config?.modelOverrides)
        if (config?.modelOverrides !== undefined && !overrides) continue
        const existing = overrides?.[id]
        const override = mapping(existing)
        if ((existing !== undefined && !override) || override?.reasoning !== undefined || override?.thinking !== undefined) continue
        const target = ['providers', provider, 'modelOverrides', id]
        yaml.setIn([...target, 'reasoning'], true)
        yaml.setIn([...target, 'thinking'], thinking)
        changed = true
      }
      if (!changed) return false
      const latest = readModelsFile(file)
      if (!latest.ok || latest.raw !== current.raw) return false
      writeModelsFile(file, yaml.toString())
      return true
    } catch {
      return false
    }
  })
}

/** List custom providers from models.yml. Keys are NEVER returned — hasKey only. */
export function listCustomProviders(deps: CustomProvidersDeps = {}): CustomProvidersListResult {
  const file = deps.modelsFile ?? defaultModelsFile()
  const read = readModelsFile(file)
  if (!read.ok) return { ok: false, error: read.error, detail: read.detail }
  const providers: CustomProviderInfo[] = []
  for (const [id, value] of Object.entries(read.doc.providers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const e = value as Record<string, unknown>
    const discovery = e.discovery !== undefined && e.discovery !== null
    const rawModels = Array.isArray(e.models) ? e.models : []
    providers.push({
      id,
      baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : '',
      api: typeof e.api === 'string' ? e.api : '',
      hasKey: typeof e.apiKey === 'string' && e.apiKey.length > 0,
      authNone: e.auth === 'none',
      discovery,
      models: rawModels
        .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
        .map((m) => ({
          id: typeof m.id === 'string' ? m.id : '',
          name: typeof m.name === 'string' ? m.name : '',
          ...((typeof m.baseUrl === 'string' && m.baseUrl.replace(/\/+$/, '') !== String(e.baseUrl ?? '').replace(/\/+$/, '')) ||
              (typeof m.api === 'string' && m.api !== e.api) ? { hasCustomTransport: true } : {}),
          input: modelInputs(m.input),
          ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
          ...(typeof m.maxTokens === 'number' ? { maxTokens: m.maxTokens } : {})
        }))
        .filter((m) => m.id),
      source: 'custom'
    })
  }
  return { ok: true, providers }
}

/**
 * Upsert one custom provider into models.yml, then verify against the real
 * runtime (`omp models --json` is credential-filtered, so the provider's
 * models appear only when omp accepted the entry AND resolved a credential).
 * A failed verification rolls the file back to its pre-write bytes.
 */
export function saveCustomProvider(
  rawSpec: CustomProviderSpec,
  deps: CustomProvidersDeps = {}
): Promise<CustomProviderSaveResult> {
  return enqueue(async () => {
    const file = deps.modelsFile ?? defaultModelsFile()
    const read = readModelsFile(file)
    if (!read.ok) return { ok: false, error: read.error, detail: read.detail }

    const existing = read.doc.providers[rawSpec.id]
    const existingKey =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? typeof (existing as Record<string, unknown>).apiKey === 'string'
          ? ((existing as Record<string, unknown>).apiKey as string)
          : undefined
        : undefined

    const invalid = validateSpec(rawSpec, existingKey !== undefined)
    if (invalid) return { ok: false, error: invalid }

    const catalog = deps.modelCatalog ?? await listOmpModelCatalog(rawSpec.id)
    if (!GENERIC_CUSTOM_PROVIDER_APIS.some(api => api === rawSpec.api) &&
        !catalog.some(model => matchesCatalogEndpoint(model, rawSpec))) return { ok: false, error: 'invalid-api' }
    const next: ModelsDoc = {
      providers: { ...read.doc.providers, [rawSpec.id]: buildEntry(rawSpec, catalog, existingKey, mapping(existing)) }
    }
    let content: string
    try {
      content = YAML.stringify({ providers: next.providers })
    } catch (err) {
      return { ok: false, error: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
    }
    try {
      writeModelsFile(file, content)
    } catch (err) {
      return { ok: false, error: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
    }

    const run = deps.runner === null ? null : (deps.runner ?? defaultRunner())
    if (!run) return { ok: true, verified: false }
    const verified = await verifyWithRuntime(run, rawSpec.id)
    if (verified === null) return { ok: true, verified: false }
    if (!verified) {
      restoreModelsFile(file, read.raw)
      return { ok: false, error: 'verify-failed' }
    }
    return { ok: true, verified: true }
  })
}

/**
 * Remove one provider from models.yml. When the last provider is removed the
 * file is kept with an empty `providers: {}` map — deleting the file would be
 * equivalent to omp, but keeping it avoids create/delete churn on re-add and
 * is just as valid.
 */
export function deleteCustomProvider(
  id: string,
  deps: CustomProvidersDeps = {}
): Promise<CustomProviderDeleteResult> {
  return enqueue(async () => {
    if (!PROVIDER_ID_PATTERN.test(id)) return { ok: false }
    const file = deps.modelsFile ?? defaultModelsFile()
    if (!existsSync(file)) return { ok: true }
    const read = readModelsFile(file)
    if (!read.ok) return { ok: false, error: read.error }
    if (!(id in read.doc.providers)) return { ok: true }
    const providers = { ...read.doc.providers }
    delete providers[id]
    try {
      writeModelsFile(file, YAML.stringify({ providers }))
      return { ok: true }
    } catch {
      return { ok: false, error: 'write-failed' }
    }
  })
}

// ---------------------------------------------------------------------------
// API keys for ANY provider (built-in or custom)
//
// The simple, spawn-free credential path: models.yml override-only entries.
// omp's auth resolution puts `providers.<id>.apiKey` above env vars and the
// vault (docs/models.md), and an override-only `{apiKey}` entry is enough to
// make a built-in provider's models available (verified live, omp 17.2.7:
// deepseek with just an apiKey entry lists deepseek/* in `omp models --json`).
// This replaces the RPC login flow for key saving — that flow spawns a
// runtime and drives interactive prompts, which can hang; a file write plus
// a post-write `omp models --json` presence check cannot.
// ---------------------------------------------------------------------------

/**
 * Set/replace a provider's API key in models.yml, preserving the provider's
 * other fields (a custom provider keeps its baseUrl/models). Verified by
 * `omp models --json` (credential-present check) with rollback on rejection.
 */
export function saveProviderKey(
  providerId: string,
  key: string,
  deps: CustomProvidersDeps = {}
): Promise<CustomProviderSaveResult> {
  return enqueue(async () => {
    if (!PROVIDER_ID_PATTERN.test(providerId)) return { ok: false, error: 'invalid-id' }
    const trimmed = key.trim()
    if (!trimmed || trimmed.length > MAX_API_KEY_LENGTH || CONTROL_RE.test(trimmed)) {
      return { ok: false, error: 'invalid-api-key' }
    }
    const file = deps.modelsFile ?? defaultModelsFile()
    const read = readModelsFile(file)
    if (!read.ok) return { ok: false, error: read.error, detail: read.detail }

    const existing = read.doc.providers[providerId]
    const prev =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {}
    delete prev.auth // a real key replaces a keyless marker
    prev.apiKey = trimmed

    let content: string
    try {
      content = YAML.stringify({ providers: { ...read.doc.providers, [providerId]: prev } })
    } catch (err) {
      return { ok: false, error: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
    }
    try {
      writeModelsFile(file, content)
    } catch (err) {
      return { ok: false, error: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
    }

    const run = deps.runner === null ? null : (deps.runner ?? defaultRunner())
    if (!run) return { ok: true, verified: false }
    const verified = await verifyWithRuntime(run, providerId)
    if (verified === null) return { ok: true, verified: false }
    if (!verified) {
      restoreModelsFile(file, read.raw)
      return { ok: false, error: 'verify-failed' }
    }
    // Presence ≠ validity: a typo'd key resolves fine and then 401s every
    // turn. Probe the provider's model list when we know its endpoint —
    // only a definitive 401/403 fails the save, everything else passes.
    const endpoint = await endpointForKeyCheck(providerId, prev)
    if (endpoint) {
      const live = await liveKeyCheck(endpoint.baseUrl, endpoint.api, trimmed, deps.fetchImpl)
      if (live === 'rejected') {
        restoreModelsFile(file, read.raw)
        return { ok: false, error: 'invalid-api-key', detail: 'the provider rejected this key (401/403)' }
      }
    }
    return { ok: true, verified: true }
  })
}

/** Endpoint for the live key check: the entry itself (custom), else the catalog. */
async function endpointForKeyCheck(
  providerId: string,
  entry: Record<string, unknown>
): Promise<{ baseUrl: string; api: string } | null> {
  if (typeof entry.baseUrl === 'string' && entry.baseUrl) {
    return { baseUrl: entry.baseUrl, api: typeof entry.api === 'string' ? entry.api : '' }
  }
  const catalog = await listOmpModelCatalog(providerId)
  const withEndpoint = catalog.find((m) => m.baseUrl)
  return withEndpoint?.baseUrl
    ? { baseUrl: withEndpoint.baseUrl, api: withEndpoint.api ?? '' }
    : null
}

/**
 * Remove a provider's credential: the models.yml apiKey entry (dropping the
 * entry entirely when it held nothing else) plus a best-effort vault logout
 * (`omp auth-broker logout`) for credentials stored by earlier login flows.
 * Verified by disappearance — if the provider's models are still listed
 * afterwards, a credential survives somewhere (e.g. an env var) and we say so.
 */
export function clearProviderKey(
  providerId: string,
  deps: CustomProvidersDeps = {}
): Promise<{ ok: boolean; error?: string }> {
  return enqueue(async () => {
    if (!PROVIDER_ID_PATTERN.test(providerId)) return { ok: false, error: 'invalid-id' }
    const file = deps.modelsFile ?? defaultModelsFile()
    const read = readModelsFile(file)
    if (!read.ok) return { ok: false, error: read.error }
    const existing = read.doc.providers[providerId]
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const entry = { ...(existing as Record<string, unknown>) }
      delete entry.apiKey
      const providers = { ...read.doc.providers }
      if (Object.keys(entry).length === 0) delete providers[providerId]
      else providers[providerId] = entry
      try {
        writeModelsFile(file, YAML.stringify({ providers }))
      } catch {
        return { ok: false, error: 'write-failed' }
      }
    }
    // Best-effort vault cleanup; absence of the CLI or the credential is fine.
    const run = deps.runner === null ? null : (deps.runner ?? defaultRunner())
    if (run) await run(['auth-broker', 'logout', providerId])
    return { ok: true }
  })
}
