import { chmodSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ModelConfig, PackageActionResult } from '../shared/types'
import { detectCli } from './omp'

/**
 * Read/write helpers for pi's own configuration files:
 * - ~/.pi/agent/settings.json — model defaults, project trust, packages
 * - ~/.pi/agent/auth.json     — provider credentials (api_key entries; OAuth
 *   blobs written by `pi /login` are preserved untouched)
 */

export function defaultPiAgentDir(cliCommand: string = detectCli().command): string {
  const dir = cliCommand === 'omp' ? '.omp' : '.pi'
  return path.join(homedir(), dir, 'agent')
}

export interface PiSettings {
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  defaultProjectTrust?: string
  packages?: unknown[]
  [key: string]: unknown
}

export function readPiSettings(piAgentDir: string): PiSettings {
  try {
    return JSON.parse(readFileSync(path.join(piAgentDir, 'settings.json'), 'utf-8'))
  } catch {
    return {}
  }
}

export function writePiSettings(piAgentDir: string, settings: PiSettings): void {
  const target = path.join(piAgentDir, 'settings.json')
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  renameSync(tmp, target)
}

// ---------------------------------------------------------------------------
// Machine-local skills (~/.agents/skills)
//
// pi unconditionally loads every skill it finds under ~/.agents/skills — a
// directory shared with other agents on this machine (Kimi CLI's lark-* set
// and the like). That leaks unrelated abilities into every GUI session. The
// GUI therefore manages pi's own `skills` override list: for each discovered
// skill directory it writes a `!<name>` exclusion (pi matches overrides by
// basename), and removes exactly those entries again when re-enabled.
// ---------------------------------------------------------------------------

export function machineSkillsDir(): string {
  return path.join(homedir(), '.agents', 'skills')
}

/** Names of skill directories present under ~/.agents/skills. */
export function listMachineSkillNames(dir: string = machineSkillsDir()): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Sync pi's skills overrides with the desired state. Returns the names that
 * were excluded. Only entries the GUI manages (exact `!<machine skill name>`)
 * are touched — user-written patterns and other overrides are preserved.
 */
export function syncMachineSkills(
  enabled: boolean,
  piAgentDir: string = defaultPiAgentDir(),
  skillsDir: string = machineSkillsDir()
): string[] {
  const names = listMachineSkillNames(skillsDir)
  if (names.length === 0) return []
  const settings = readPiSettings(piAgentDir)
  const current = Array.isArray(settings.skills)
    ? settings.skills.filter((s): s is string => typeof s === 'string')
    : []
  const managed = names.map((n) => `!${n}`)
  const kept = current.filter((s) => !managed.includes(s))
  const next = enabled ? kept : [...kept, ...managed.filter((m) => !kept.includes(m))]
  if (next.length === 0) delete settings.skills
  else settings.skills = next
  writePiSettings(piAgentDir, settings)
  return enabled ? [] : names
}

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
const TRUST_MODES = new Set(['ask', 'always', 'never'])

export function getModelConfig(piAgentDir: string = defaultPiAgentDir()): ModelConfig {
  const settings = readPiSettings(piAgentDir)
  return {
    defaultProvider: typeof settings.defaultProvider === 'string' ? settings.defaultProvider : '',
    defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : '',
    defaultThinkingLevel: THINKING_LEVELS.has(settings.defaultThinkingLevel ?? '')
      ? (settings.defaultThinkingLevel as ModelConfig['defaultThinkingLevel'])
      : '',
    projectTrust: TRUST_MODES.has(settings.defaultProjectTrust ?? '')
      ? (settings.defaultProjectTrust as ModelConfig['projectTrust'])
      : 'ask',
    authProviders: listAuthProviders(piAgentDir)
  }
}

export function setModelConfig(
  patch: Partial<Omit<ModelConfig, 'authProviders'>>,
  piAgentDir: string = defaultPiAgentDir()
): PackageActionResult {
  const settings = readPiSettings(piAgentDir)
  const apply = (key: 'defaultProvider' | 'defaultModel' | 'defaultThinkingLevel', value?: string) => {
    if (value === undefined) return
    if (value.trim() === '') delete settings[key]
    else settings[key] = value.trim()
  }
  apply('defaultProvider', patch.defaultProvider)
  apply('defaultModel', patch.defaultModel)
  apply('defaultThinkingLevel', patch.defaultThinkingLevel)
  if (patch.projectTrust !== undefined) {
    if (!TRUST_MODES.has(patch.projectTrust)) {
      return { ok: false, log: `invalid project trust mode: ${patch.projectTrust}` }
    }
    settings.defaultProjectTrust = patch.projectTrust
  }
  try {
    writePiSettings(piAgentDir, settings)
    return { ok: true, log: '' }
  } catch (err) {
    return { ok: false, log: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Credentials (auth.json)
// ---------------------------------------------------------------------------

type AuthFile = Record<string, { type?: string; key?: string; [key: string]: unknown }>

function authPath(piAgentDir: string): string {
  return path.join(piAgentDir, 'auth.json')
}

function readAuth(piAgentDir: string): AuthFile {
  try {
    const parsed = JSON.parse(readFileSync(authPath(piAgentDir), 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAuth(piAgentDir: string, auth: AuthFile): void {
  const target = authPath(piAgentDir)
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, target)
}

/** Which providers hold credentials — keys only, values never leave the main process. */
export function listAuthProviders(piAgentDir: string = defaultPiAgentDir()): string[] {
  return Object.keys(readAuth(piAgentDir)).sort()
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/

export function setApiKey(
  provider: string,
  key: string,
  piAgentDir: string = defaultPiAgentDir()
): PackageActionResult {
  if (!PROVIDER_ID.test(provider)) {
    return { ok: false, log: `invalid provider id: ${provider}` }
  }
  if (!key.trim() || key.length > 1000) {
    return { ok: false, log: 'invalid api key' }
  }
  const auth = readAuth(piAgentDir)
  const existing = auth[provider]
  // Preserve OAuth blobs; only replace api_key entries or create new ones
  if (existing && existing.type && existing.type !== 'api_key') {
    return { ok: false, log: `${provider} uses ${existing.type} auth; use pi /logout first` }
  }
  auth[provider] = { type: 'api_key', key: key.trim() }
  try {
    writeAuth(piAgentDir, auth)
    return { ok: true, log: '' }
  } catch (err) {
    return { ok: false, log: err instanceof Error ? err.message : String(err) }
  }
}

export function clearApiKey(
  provider: string,
  piAgentDir: string = defaultPiAgentDir()
): PackageActionResult {
  if (!PROVIDER_ID.test(provider)) {
    return { ok: false, log: `invalid provider id: ${provider}` }
  }
  const auth = readAuth(piAgentDir)
  if (!(provider in auth)) return { ok: true, log: '' }
  delete auth[provider]
  try {
    writeAuth(piAgentDir, auth)
    return { ok: true, log: '' }
  } catch (err) {
    return { ok: false, log: err instanceof Error ? err.message : String(err) }
  }
}
