import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectError, ProjectRecord } from '../shared/types'
import { canonicalExistingPath } from './canonicalPath'
import { beginProjectDeletion, endProjectDeletion, isProjectDeletionInProgress, pathsOverlap } from './projectDeletionGate'

interface StoredProject {
  id: string
  name: string
  path: string
  archived: boolean
  isDefault: boolean
  createdAt: number
  dev: number | null
  ino: number | null
}
interface ProjectStore { version: 1; projects: StoredProject[]; importedRecent: boolean }
export type RegistryResult = { ok: true; project: ProjectRecord } | { ok: false; error: ProjectError; message?: string }

export interface ProjectRegistryOptions {
  file: string
  defaultPath: string
  protectedPaths: string[]
  recentPaths: () => string[]
  isBusy: (projectPath: string) => boolean
  confirmDelete: (projectPath: string, sessions: number) => Promise<boolean>
  trash: (target: string) => Promise<void>
  closeIdleSessions: (projectPath: string) => Promise<boolean>
  /** Session paths supplied by a Main-only scanner; never from renderer. */
  discoverSessions: (projectPath: string) => Promise<Array<{ path: string; dev: number; ino: number }>>
}

/** Filesystem and network-share roots are never eligible for project removal. */
export function isFilesystemRoot(target: string, pathApi: typeof path = path): boolean {
  let normalized = pathApi.resolve(target)
  if (pathApi.sep === '\\') {
    // Extended-length UNC syntax is parsed by Node as root "\\?\\UNC\\";
    // strip the namespace so the server/share itself remains the protected root.
    normalized = normalized.replace(/^\\\\\?\\UNC\\/i, '\\\\')
    normalized = normalized.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '')
    normalized = pathApi.resolve(normalized)
  }
  const root = pathApi.parse(normalized).root
  return !!root && pathApi.relative(root, normalized) === ''
}

function insideOrEqual(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function identify(target: string): { path: string; dev: number; ino: number } | null {
  try {
    const canonical = canonicalExistingPath(target)
    const stat = fs.lstatSync(canonical)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    return { path: canonical, dev: stat.dev, ino: stat.ino }
  } catch { return null }
}
export function validProjectName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 80 && value !== '.' && value !== '..' && !/[\\/:*?"<>|\x00-\x1f\x7f]/.test(value) && !/[. ]$/.test(value)
}

/** Durable registry stores filesystem identity; renderers only select opaque IDs. */
export class ProjectRegistry {
  private readonly options: ProjectRegistryOptions
  constructor(options: ProjectRegistryOptions) { this.options = options }

  private load(): ProjectStore {
    let raw: unknown
    try { raw = JSON.parse(fs.readFileSync(this.options.file, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: [], importedRecent: false }
      throw new Error('project-store-unreadable')
    }
    if (!raw || typeof raw !== 'object') throw new Error('project-store-unreadable')
    const data = raw as ProjectStore
    if (data.version !== 1 || !Array.isArray(data.projects) || typeof data.importedRecent !== 'boolean') throw new Error('project-store-unreadable')
    if (data.projects.some(p => !p || typeof p.id !== 'string' || !p.id || typeof p.path !== 'string' || !path.isAbsolute(p.path) || typeof p.name !== 'string' || typeof p.archived !== 'boolean' || typeof p.isDefault !== 'boolean' || typeof p.createdAt !== 'number' || !(p.dev === null || typeof p.dev === 'number') || !(p.ino === null || typeof p.ino === 'number'))) throw new Error('project-store-unreadable')
    return data
  }
  private write(store: ProjectStore): void {
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true })
    const temporary = `${this.options.file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, this.options.file)
    } catch (error) { try { fs.unlinkSync(temporary) } catch { /* best effort */ }; throw error }
  }
  private init(): ProjectStore {
    const store = this.load()
    let changed = false
    let defaultWasMissing = false
    try { fs.lstatSync(this.options.defaultPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      defaultWasMissing = true
    }
    fs.mkdirSync(this.options.defaultPath, { recursive: true })
    const identity = identify(this.options.defaultPath)
    if (!identity) throw new Error('default-project-unavailable')
    let defaultProject = store.projects.find(p => p.isDefault)
    if (defaultProject && defaultWasMissing) {
      const expected = path.join(canonicalExistingPath(path.dirname(this.options.defaultPath)), path.basename(this.options.defaultPath))
      const direct = fs.lstatSync(this.options.defaultPath)
      if (!direct.isSymbolicLink() && identity.path === expected && defaultProject.path === expected) {
        defaultProject.dev = identity.dev
        defaultProject.ino = identity.ino
        defaultProject.archived = false
        changed = true
      }
    }
    if (!defaultProject) {
      defaultProject = store.projects.find(p => p.path === identity.path)
      if (defaultProject) { defaultProject.isDefault = true; defaultProject.archived = false }
      else store.projects.unshift({ id: randomUUID(), name: '投手工作区', ...identity, archived: false, isDefault: true, createdAt: Date.now() })
      changed = true
    }
    if (!store.importedRecent) {
      for (const raw of this.options.recentPaths()) {
        if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue
        const resolved = identify(raw)
        const projectPath = resolved?.path ?? path.resolve(raw)
        if (store.projects.some(p => p.path === projectPath)) continue
        store.projects.push({ id: randomUUID(), name: path.basename(projectPath) || '项目', path: projectPath, dev: resolved?.dev ?? null, ino: resolved?.ino ?? null, archived: false, isDefault: false, createdAt: Date.now() })
      }
      store.importedRecent = true
      changed = true
    }
    if (changed) this.write(store)
    return store
  }
  private view(item: StoredProject): ProjectRecord {
    const found = identify(item.path)
    const missing = !found || found.path !== item.path || found.dev !== item.dev || found.ino !== item.ino
    return { id: item.id, name: item.name, path: item.path, archived: item.archived, missing, isDefault: item.isDefault, createdAt: item.createdAt }
  }
  list(): ProjectRecord[] { return this.init().projects.map(item => this.view(item)) }
  get(id: unknown): ProjectRecord | null {
    if (typeof id !== 'string') return null
    const item = this.init().projects.find(p => p.id === id)
    return item ? this.view(item) : null
  }
  register(target: string, name?: string): RegistryResult {
    if (name !== undefined && !validProjectName(name)) return { ok: false, error: 'invalid-name' }
    const identity = identify(target)
    if (!identity) return { ok: false, error: 'missing' }
    if (isProjectDeletionInProgress(identity.path)) return { ok: false, error: 'busy' }
    const store = this.init()
    let item = store.projects.find(p => p.path === identity.path)
    if (item) {
      // A native folder choice reauthorizes an existing missing/replaced path.
      item.dev = identity.dev; item.ino = identity.ino; item.archived = false
      if (name && !item.isDefault) item.name = name
    } else {
      item = { id: randomUUID(), name: name ?? (path.basename(identity.path) || '项目'), ...identity, archived: false, isDefault: false, createdAt: Date.now() }
      store.projects.push(item)
    }
    this.write(store)
    return { ok: true, project: this.view(item) }
  }
  setArchived(id: unknown, archived: boolean): RegistryResult {
    if (typeof id !== 'string') return { ok: false, error: 'not-found' }
    const store = this.init(); const item = store.projects.find(p => p.id === id)
    if (!item) return { ok: false, error: 'not-found' }
    if (item.isDefault) return { ok: false, error: 'protected' }
    if (isProjectDeletionInProgress(item.path) || (archived && this.options.isBusy(item.path))) return { ok: false, error: 'busy' }
    item.archived = archived
    this.write(store)
    return { ok: true, project: this.view(item) }
  }
  private safeToDelete(item: StoredProject, store: ProjectStore): ProjectError | null {
    if (item.isDefault || isFilesystemRoot(item.path)) return 'protected'
    const identity = identify(item.path)
    if (!identity) return 'missing'
    if (identity.path !== item.path || identity.dev !== item.dev || identity.ino !== item.ino) return 'path-changed'
    // Reject a replacement symlink even if its target resolves to the original.
    try { if (fs.lstatSync(item.path).isSymbolicLink()) return 'path-changed' } catch { return 'missing' }
    for (const candidate of [...this.options.protectedPaths, this.options.defaultPath]) {
      let protectedPath = path.resolve(candidate)
      try { protectedPath = canonicalExistingPath(protectedPath) } catch { /* missing protected path */ }
      if (insideOrEqual(item.path, protectedPath)) return 'protected'
    }
    if (store.projects.some(p => p.id !== item.id && pathsOverlap(item.path, p.path))) return 'protected'
    if (this.options.isBusy(item.path)) return 'busy'
    return null
  }
  async delete(id: unknown): Promise<RegistryResult> {
    if (typeof id !== 'string') return { ok: false, error: 'not-found' }
    let store = this.init(); let item = store.projects.find(p => p.id === id)
    if (!item) return { ok: false, error: 'not-found' }
    if (isProjectDeletionInProgress(item.path)) return { ok: false, error: 'busy' }
    let reason = this.safeToDelete(item, store)
    if (reason) return { ok: false, error: reason }
    const lockedPath = item.path
    if (!beginProjectDeletion(lockedPath)) return { ok: false, error: 'busy' }
    try {
      const sessions = await this.options.discoverSessions(item.path)
      if (!(await this.options.confirmDelete(item.path, sessions.length))) return { ok: false, error: 'cancelled' }
      store = this.init(); item = store.projects.find(p => p.id === id)
      if (!item) return { ok: false, error: 'not-found' }
      reason = this.safeToDelete(item, store)
      if (reason) return { ok: false, error: reason }
      if (!(await this.options.closeIdleSessions(item.path))) return { ok: false, error: 'busy' }
      const currentSessions = await this.options.discoverSessions(item.path)
      const keys = (items: typeof sessions) => items.map(row => `${row.path}\u0000${row.dev}\u0000${row.ino}`).sort().join('\n')
      if (keys(currentSessions) !== keys(sessions)) return { ok: false, error: 'path-changed' }
      for (const session of sessions) {
        reason = this.safeToDelete(item, this.init())
        if (reason) return { ok: false, error: reason }
        const st = fs.lstatSync(session.path)
        if (!st.isFile() || st.isSymbolicLink() || canonicalExistingPath(session.path) !== session.path || st.dev !== session.dev || st.ino !== session.ino) return { ok: false, error: 'partial-failure', message: '会话记录已变化；项目目录未删除，请检查后重试。' }
        try { await this.options.trash(session.path) } catch { return { ok: false, error: 'partial-failure', message: '部分会话记录未能移入废纸篓；项目目录保留，可检查后重试。' } }
      }
      reason = this.safeToDelete(item, this.init())
      if (reason) return { ok: false, error: reason }
      try { await this.options.trash(item.path) } catch { return { ok: false, error: 'partial-failure', message: '项目目录未能移入废纸篓；已处理的会话可从废纸篓恢复。' } }
      const latest = this.init()
      latest.projects = latest.projects.filter(p => p.id !== id)
      this.write(latest)
      return { ok: true, project: this.view(item) }
    } catch {
      return { ok: false, error: 'partial-failure', message: '无法安全完成删除；项目记录已保留，请检查文件和废纸篓。' }
    } finally { endProjectDeletion(lockedPath) }
  }
}
