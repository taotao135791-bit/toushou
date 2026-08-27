import crypto from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  ManagedPluginActionResult,
  ManagedPluginDescriptor,
  ManagedPluginDetail,
  ManagedPluginDraft,
  ManagedPluginSaveResult
} from '../shared/types'
import { isValidPackageName, isValidVersion } from '../shared/pluginScaffold'
import { detectCli } from './omp'
import { linkLocalPackage, removePackage } from './packages'

/**
 * User-authored plugin sources are kept in an app-owned root, never a folder
 * supplied by the renderer. OMP links that root for fast edit → reload cycles;
 * the registry lets the UI recover the source and delete it deliberately.
 */

const MAX_CODE_LENGTH = 200_000
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_DISPLAY_NAME_LENGTH = 200
const MAX_ERROR_LENGTH = 500
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ManagedPluginStorageLocations {
  rootDir: string
  registryPath: string
}

interface StoredManagedPlugin extends ManagedPluginDescriptor {}

function defaultLocations(): ManagedPluginStorageLocations {
  const rootDir = path.join(app.getPath('userData'), 'managed-plugins')
  return { rootDir, registryPath: path.join(rootDir, 'registry.json') }
}

function safeError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value)
  return raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validStoredPlugin(value: unknown): value is StoredManagedPlugin {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return false
  if (typeof value.name !== 'string' || !isValidPackageName(value.name)) return false
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > MAX_DESCRIPTION_LENGTH) return false
  if (value.displayName !== undefined && (typeof value.displayName !== 'string' || value.displayName.length > MAX_DISPLAY_NAME_LENGTH)) return false
  if (typeof value.version !== 'string' || !isValidVersion(value.version)) return false
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return false
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return false
  if (value.syncedAt !== undefined && (typeof value.syncedAt !== 'number' || !Number.isFinite(value.syncedAt))) return false
  if (value.lastSyncError !== undefined && (typeof value.lastSyncError !== 'string' || value.lastSyncError.length > MAX_ERROR_LENGTH)) return false
  return true
}

function descriptor(record: StoredManagedPlugin): ManagedPluginDescriptor {
  const { id, name, displayName, description, version, createdAt, updatedAt, syncedAt, lastSyncError } = record
  return {
    id,
    name,
    ...(displayName ? { displayName } : {}),
    description,
    version,
    createdAt,
    updatedAt,
    ...(syncedAt ? { syncedAt } : {}),
    ...(lastSyncError ? { lastSyncError } : {})
  }
}

function ensureSafeRoot(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  if (!statSync(rootDir).isDirectory() || lstatSync(rootDir).isSymbolicLink()) {
    throw new Error('Managed plugin storage is not a safe directory.')
  }
}

function pluginDir(locations: ManagedPluginStorageLocations, id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid managed plugin id.')
  const root = path.resolve(locations.rootDir)
  const dir = path.resolve(root, id)
  if (!dir.startsWith(root + path.sep)) throw new Error('Unsafe managed plugin path.')
  return dir
}

function readRegistry(locations: ManagedPluginStorageLocations): StoredManagedPlugin[] | { error: string } {
  if (!existsSync(locations.registryPath)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(locations.registryPath, 'utf-8'))
  } catch {
    return { error: 'Managed plugin registry is not valid JSON.' }
  }
  if (!Array.isArray(parsed) || !parsed.every(validStoredPlugin)) {
    return { error: 'Managed plugin registry has an invalid shape.' }
  }
  const ids = new Set<string>()
  for (const record of parsed) {
    if (ids.has(record.id)) return { error: 'Managed plugin registry contains duplicate ids.' }
    ids.add(record.id)
  }
  return parsed
}

function registryError(value: StoredManagedPlugin[] | { error: string }): value is { error: string } {
  return !Array.isArray(value)
}

function writeRegistry(locations: ManagedPluginStorageLocations, records: StoredManagedPlugin[]): void {
  ensureSafeRoot(locations.rootDir)
  const tmp = `${locations.registryPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  renameSync(tmp, locations.registryPath)
}

function validateDraft(raw: unknown): { ok: true; draft: Required<Omit<ManagedPluginDraft, 'id'>> & { id?: string } } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid plugin draft.' }
  const id = raw.id === undefined ? undefined : typeof raw.id === 'string' ? raw.id : null
  if (id === null || (id !== undefined && !ID_PATTERN.test(id))) return { ok: false, error: 'Invalid plugin id.' }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : ''
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  const code = typeof raw.code === 'string' ? raw.code : ''
  if (!isValidPackageName(name)) return { ok: false, error: 'Use a valid lowercase npm-style package name.' }
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) return { ok: false, error: 'Description must be 1–2,000 characters.' }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) return { ok: false, error: 'Display name is too long.' }
  if (!isValidVersion(version)) return { ok: false, error: 'Version must use semver, such as 0.1.0.' }
  if (!code.trim() || code.length > MAX_CODE_LENGTH || code.includes('\0')) {
    return { ok: false, error: 'Plugin code must be non-empty and at most 200,000 characters.' }
  }
  return {
    ok: true,
    draft: { ...(id ? { id } : {}), name, description, displayName, version, code }
  }
}

function renderManifest(record: StoredManagedPlugin): string {
  const manifest: Record<string, unknown> = {
    name: record.name,
    version: record.version,
    description: record.description,
    private: true,
    keywords: ['omp-plugin', 'pi-package', 'omp-gui-managed'],
    // OMP reads its own manifest first; pi is retained so a user can also
    // inspect/develop the generated package with the compatible legacy host.
    omp: { extensions: ['extensions/index.ts'] },
    pi: { extensions: ['extensions/index.ts'] },
    files: ['extensions']
  }
  if (record.displayName) manifest.displayName = record.displayName
  return JSON.stringify(manifest, null, 2) + '\n'
}

function renderReadme(record: StoredManagedPlugin): string {
  return `# ${record.displayName || record.name}

${record.description}

This local plugin is managed by OMP GUI. Edit it from **Plugins → Write plugin**,
then choose **Save & sync** and start a new session (or run the runtime reload
command) to apply changes.
`
}

interface SourceSwap {
  finalize: () => void
  rollback: () => void
}

/** Stage the complete package before a rename so editors never see partial source. */
function replacePluginSource(
  locations: ManagedPluginStorageLocations,
  record: StoredManagedPlugin,
  code: string
): SourceSwap {
  ensureSafeRoot(locations.rootDir)
  const target = pluginDir(locations, record.id)
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !statSync(target).isDirectory())) {
    throw new Error('Managed plugin source path is unsafe.')
  }
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  const staging = path.join(locations.rootDir, `.staging-${record.id}-${nonce}`)
  const backup = path.join(locations.rootDir, `.backup-${record.id}-${nonce}`)
  try {
    mkdirSync(path.join(staging, 'extensions'), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(staging, 'package.json'), renderManifest(record), { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    writeFileSync(path.join(staging, 'README.md'), renderReadme(record), { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    writeFileSync(path.join(staging, 'extensions', 'index.ts'), code.endsWith('\n') ? code : `${code}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx'
    })
    const hadTarget = existsSync(target)
    if (hadTarget) renameSync(target, backup)
    try {
      renameSync(staging, target)
    } catch (error) {
      if (hadTarget && existsSync(backup)) renameSync(backup, target)
      throw error
    }
    return {
      finalize: () => {
        if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      },
      rollback: () => {
        try {
          if (existsSync(target)) rmSync(target, { recursive: true, force: true })
          if (existsSync(backup)) renameSync(backup, target)
        } catch {
          // Best effort only; the user gets a clear persistence error.
        }
      }
    }
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

function readPluginCode(locations: ManagedPluginStorageLocations, id: string): string | null {
  const source = path.join(pluginDir(locations, id), 'extensions', 'index.ts')
  try {
    if (lstatSync(source).isSymbolicLink() || !statSync(source).isFile()) return null
    const code = readFileSync(source, 'utf-8')
    return code.length <= MAX_CODE_LENGTH ? code : null
  } catch {
    return null
  }
}

function updateRegistryRecord(
  locations: ManagedPluginStorageLocations,
  id: string,
  mutate: (record: StoredManagedPlugin) => StoredManagedPlugin
): StoredManagedPlugin | null {
  const records = readRegistry(locations)
  if (registryError(records)) return null
  const index = records.findIndex((record) => record.id === id)
  if (index < 0) return null
  const next = mutate(records[index])
  records[index] = next
  try {
    writeRegistry(locations, records)
    return next
  } catch {
    return null
  }
}

export function listManagedPlugins(overrides: Partial<ManagedPluginStorageLocations> = {}): ManagedPluginDescriptor[] {
  const locations = { ...defaultLocations(), ...overrides }
  const records = readRegistry(locations)
  if (registryError(records)) throw new Error(records.error)
  return records.map(descriptor).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getManagedPlugin(
  id: unknown,
  overrides: Partial<ManagedPluginStorageLocations> = {}
): ManagedPluginDetail | null {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null
  const locations = { ...defaultLocations(), ...overrides }
  const records = readRegistry(locations)
  if (registryError(records)) throw new Error(records.error)
  const record = records.find((candidate) => candidate.id === id)
  if (!record) return null
  const code = readPluginCode(locations, id)
  return code === null ? null : { ...descriptor(record), code }
}

export function saveManagedPlugin(
  raw: unknown,
  overrides: Partial<ManagedPluginStorageLocations> = {}
): ManagedPluginSaveResult {
  const validated = validateDraft(raw)
  if (!validated.ok) return validated
  const locations = { ...defaultLocations(), ...overrides }
  const records = readRegistry(locations)
  if (registryError(records)) return { ok: false, error: records.error }
  const now = Date.now()
  const index = validated.draft.id ? records.findIndex((record) => record.id === validated.draft.id) : -1
  if (validated.draft.id && index < 0) return { ok: false, error: 'This handwritten plugin no longer exists.' }
  const previous = index >= 0 ? records[index] : undefined
  if (previous?.syncedAt && previous.name !== validated.draft.name) {
    return {
      ok: false,
      error: 'A synced plugin keeps its package name. Create a new plugin to use a different name.'
    }
  }
  const record: StoredManagedPlugin = {
    id: previous?.id ?? crypto.randomUUID(),
    name: validated.draft.name,
    ...(validated.draft.displayName ? { displayName: validated.draft.displayName } : {}),
    description: validated.draft.description,
    version: validated.draft.version,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    ...(previous?.syncedAt ? { syncedAt: previous.syncedAt } : {}),
    ...(previous?.lastSyncError ? { lastSyncError: previous.lastSyncError } : {})
  }
  let swap: SourceSwap
  try {
    swap = replacePluginSource(locations, record, validated.draft.code)
  } catch (error) {
    return { ok: false, error: safeError(error) || 'Could not write the plugin source.' }
  }
  const next = [...records]
  if (index >= 0) next[index] = record
  else next.push(record)
  try {
    writeRegistry(locations, next)
    swap.finalize()
    return { ok: true, plugin: { ...descriptor(record), code: validated.draft.code } }
  } catch (error) {
    swap.rollback()
    return { ok: false, error: safeError(error) || 'Could not save the managed plugin registry.' }
  }
}

export async function syncManagedPlugin(
  id: unknown,
  overrides: Partial<ManagedPluginStorageLocations> = {}
): Promise<ManagedPluginActionResult> {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { ok: false, error: 'Invalid handwritten plugin id.', log: '' }
  }
  const locations = { ...defaultLocations(), ...overrides }
  const records = readRegistry(locations)
  if (registryError(records)) return { ok: false, error: records.error, log: '' }
  const record = records.find((candidate) => candidate.id === id)
  if (!record || !readPluginCode(locations, id)) {
    return { ok: false, error: 'The handwritten plugin source is unavailable.', log: '' }
  }
  const source = pluginDir(locations, id)
  const result = await linkLocalPackage(source)
  const redactedLog = result.log.split(source).join('[managed plugin source]')
  const now = Date.now()
  const updated = updateRegistryRecord(locations, id, (current) =>
    result.ok
      ? { ...current, syncedAt: now, updatedAt: now, lastSyncError: undefined }
      : { ...current, lastSyncError: safeError(redactedLog || 'OMP could not link the plugin.'), updatedAt: now }
  )
  if (!updated) {
    return {
      ok: false,
      error: 'OMP completed the link operation, but OMP GUI could not persist its plugin status.',
      log: redactedLog
    }
  }
  return result.ok
    ? { ok: true, plugin: descriptor(updated), log: redactedLog }
    : { ok: false, error: updated.lastSyncError ?? 'OMP could not link the plugin.', log: redactedLog }
}

export async function deleteManagedPlugin(
  id: unknown,
  overrides: Partial<ManagedPluginStorageLocations> = {}
): Promise<ManagedPluginActionResult> {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { ok: false, error: 'Invalid handwritten plugin id.', log: '' }
  }
  const locations = { ...defaultLocations(), ...overrides }
  const records = readRegistry(locations)
  if (registryError(records)) return { ok: false, error: records.error, log: '' }
  const record = records.find((candidate) => candidate.id === id)
  if (!record) return { ok: false, error: 'This handwritten plugin no longer exists.', log: '' }
  const source = pluginDir(locations, id)
  let log = ''
  if (record.syncedAt) {
    // Current OMP uninstalls by package name; legacy Pi has the local source
    // in its settings and must receive the canonical source directory instead.
    const target = detectCli().command === 'omp' ? record.name : source
    const result = await removePackage(target)
    log = result.log.split(source).join('[managed plugin source]')
    if (!result.ok) {
      return { ok: false, error: safeError(log || 'OMP could not unlink the plugin.'), log }
    }
  }
  let stagedDeletion: string | null = null
  try {
    if (existsSync(source)) {
      if (lstatSync(source).isSymbolicLink()) throw new Error('Managed plugin source path is unsafe.')
      // Move aside first. If registry persistence fails we can restore the
      // exact source tree rather than leaving a dead registry entry.
      stagedDeletion = path.join(
        locations.rootDir,
        `.deleting-${id}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      )
      renameSync(source, stagedDeletion)
    }
    writeRegistry(locations, records.filter((candidate) => candidate.id !== id))
    if (stagedDeletion && existsSync(stagedDeletion)) rmSync(stagedDeletion, { recursive: true, force: true })
    return { ok: true, log }
  } catch (error) {
    if (stagedDeletion && existsSync(stagedDeletion) && !existsSync(source)) {
      try {
        renameSync(stagedDeletion, source)
      } catch {
        // The primary error below remains more useful than a best-effort
        // restoration failure; the staged path remains under app-owned root.
      }
    }
    return { ok: false, error: safeError(error) || 'Could not delete the handwritten plugin source.', log }
  }
}
