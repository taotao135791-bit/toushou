import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { MemoryEntry, MemoryScope } from '../shared/memory'
import { getStore, setStore } from './store'

/**
 * 长期记忆存储（用户拍板的分层模型）：
 * - global.json — 所有项目共享的产品级规矩与偏好；
 * - projects/<hash>.json — 绑定一个工作区的项目记忆，别的项目物理上读不到。
 * 跨项目流动只有一条路：用户手动移动（设置页或对话内确认），没有自动机制。
 * Main 拥有全部读写；renderer 通过 IPC 访问，omp 通过回环桥访问。
 */

const MAX_ENTRIES_PER_FILE = 500
const MAX_ENTRY_CHARS = 4_000
const MAX_FILE_BYTES = 512 * 1024

interface MemoryFile {
  version: 1
  entries: MemoryEntry[]
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 64) return false
  if (!isNonEmptyString(entry.text, MAX_ENTRY_CHARS)) return false
  if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) return false
  if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) return false
  if (entry.source !== undefined && entry.source !== null) {
    if (typeof entry.source !== 'object') return false
    const source = entry.source as Record<string, unknown>
    if (source.sessionTitle !== undefined && typeof source.sessionTitle !== 'string') return false
    if (source.uuid !== undefined && typeof source.uuid !== 'string') return false
  }
  return true
}

function isMemoryFile(value: unknown): value is MemoryFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Record<string, unknown>
  return file.version === 1 && Array.isArray(file.entries) && file.entries.every(isMemoryEntry)
}

/** Stable per-project key: real path hash, immune to spelling/drive-case drift. */
export function projectMemoryKey(cwd: string): string {
  return createHash('sha256').update(cwd.replace(/[\\/]+$/, '')).digest('hex').slice(0, 16)
}

function memoryRoot(): string {
  // 用户自定义存储位置（设置页可改）；空串 = 默认 userData/memory。
  const custom = getStore('memoryStoragePath')
  if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim()
  return path.join(app.getPath('userData'), 'memory')
}

function fileFor(scope: MemoryScope, projectKey: string | null): string {
  return scope === 'global'
    ? path.join(memoryRoot(), 'global.json')
    : path.join(memoryRoot(), 'projects', `${projectKey ?? 'unknown'}.json`)
}

/** Remember which real path a project key names, for the management UI. */
function noteProjectPath(projectKey: string, cwd: string): void {
  try {
    const indexFile = path.join(memoryRoot(), 'projects', 'index.json')
    let index: Record<string, string> = {}
    try {
      index = JSON.parse(readFileSync(indexFile, 'utf-8')) as Record<string, string>
    } catch {
      // First project or unreadable index — start fresh.
    }
    if (index[projectKey] === cwd) return
    index[projectKey] = cwd
    mkdirSync(path.dirname(indexFile), { recursive: true })
    const tmp = `${indexFile}.tmp`
    writeFileSync(tmp, JSON.stringify(index), 'utf-8')
    renameSync(tmp, indexFile)
  } catch {
    // Index is cosmetic (management UI labels); storage must not depend on it.
  }
}

export function projectPathFor(key: string): string | null {
  try {
    const index = JSON.parse(readFileSync(path.join(memoryRoot(), 'projects', 'index.json'), 'utf-8')) as Record<string, string>
    return index[key] ?? null
  } catch {
    return null
  }
}

function writeFileFor(scope: MemoryScope, projectKey: string | null, entries: MemoryEntry[]): void {
  const file = fileFor(scope, projectKey)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, entries } satisfies MemoryFile), 'utf-8')
  renameSync(tmp, file)
}

/**
 * Read one layer, degrading a corrupt file to empty entries while keeping a
 * .corrupt copy for manual recovery — a broken memory file must not nuke the
 * user's accumulated notes, and must not block session creation.
 */
export function readMemoryLayer(scope: MemoryScope, projectKey: string | null): { entries: MemoryEntry[]; corrupt: boolean } {
  const file = fileFor(scope, projectKey)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { entries: [], corrupt: false }
    try {
      copyFileSync(file, `${file}.corrupt`)
    } catch {
      // Nothing worth preserving, or the copy failed — either way continue.
    }
    return { entries: [], corrupt: true }
  }
  if (!isMemoryFile(parsed)) return { entries: [], corrupt: true }
  return { entries: parsed.entries, corrupt: false }
}

export function saveMemoryEntry(input: {
  text: string
  scope: MemoryScope
  cwd?: string
  source?: MemoryEntry['source']
}): { ok: true; entry: MemoryEntry; duplicate: boolean } | { ok: false; error: 'invalid-text' | 'too-many-entries' | 'too-large' } {
  const text = input.text.trim()
  if (!isNonEmptyString(text, MAX_ENTRY_CHARS)) return { ok: false, error: 'invalid-text' }
  const projectKey = input.scope === 'project' ? projectMemoryKey(input.cwd ?? '') : null
  if (input.scope === 'project' && !input.cwd) return { ok: false, error: 'invalid-text' }
  const layer = readMemoryLayer(input.scope, projectKey)
  const existing = layer.entries.find((entry) => entry.text === text)
  if (existing) {
    // Verbatim duplicate: return the stored entry so the caller can surface
    // "already remembered" instead of growing noise.
    return { ok: true, entry: existing, duplicate: true }
  }
  if (layer.entries.length >= MAX_ENTRIES_PER_FILE) return { ok: false, error: 'too-many-entries' }
  const entry: MemoryEntry = {
    id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(input.source ? { source: input.source } : {})
  }
  const entries = [...layer.entries, entry]
  const serialized = JSON.stringify({ version: 1, entries } satisfies MemoryFile)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) return { ok: false, error: 'too-large' }
  writeFileFor(input.scope, projectKey, entries)
  if (input.scope === 'project' && input.cwd && projectKey) noteProjectPath(projectKey, input.cwd)
  return { ok: true, entry, duplicate: false }
}

export function deleteMemoryEntry(scope: MemoryScope, id: string, cwd?: string): boolean {
  const projectKey = scope === 'project' ? projectMemoryKey(cwd ?? '') : null
  const layer = readMemoryLayer(scope, projectKey)
  const next = layer.entries.filter((entry) => entry.id !== id)
  if (next.length === layer.entries.length) return false
  writeFileFor(scope, projectKey, next)
  return true
}

export function updateMemoryText(scope: MemoryScope, id: string, text: string, cwd?: string): boolean {
  if (!isNonEmptyString(text, MAX_ENTRY_CHARS)) return false
  const projectKey = scope === 'project' ? projectMemoryKey(cwd ?? '') : null
  const layer = readMemoryLayer(scope, projectKey)
  const next = layer.entries.map((entry) =>
    entry.id === id ? { ...entry, text: text.trim(), updatedAt: Date.now() } : entry
  )
  if (JSON.stringify(next) === JSON.stringify(layer.entries)) return false
  writeFileFor(scope, projectKey, next)
  return true
}

/** Move one entry between layers (手动跨项目流动的唯一通道). */
export function moveMemoryEntry(id: string, from: MemoryScope, to: MemoryScope, cwd?: string): boolean {
  const fromKey = from === 'project' ? projectMemoryKey(cwd ?? '') : null
  const toKey = to === 'project' ? projectMemoryKey(cwd ?? '') : null
  const source = readMemoryLayer(from, fromKey)
  const entry = source.entries.find((item) => item.id === id)
  if (!entry) return false
  const target = readMemoryLayer(to, toKey)
  if (target.entries.length >= MAX_ENTRIES_PER_FILE) return false
  const moved: MemoryEntry = { ...entry, updatedAt: Date.now() }
  writeFileFor(from, fromKey, source.entries.filter((item) => item.id !== id))
  writeFileFor(to, toKey, [...target.entries, moved])
  if (to === 'project' && cwd && toKey) noteProjectPath(toKey, cwd)
  return true
}

/**
 * 切换存储根目录：把现有记忆文件复制到目标目录（旧目录原样保留作备份），
 * 然后写入新设置。目标目录必须存在且为空（不覆盖用户已有数据）。
 * 返回错误码让设置页提示具体原因。
 */
export function changeMemoryStorage(targetDir: string, migrate: boolean): { ok: true; path: string } | { ok: false; error: 'same-path' | 'default-target' | 'not-empty' | 'not-writable' | 'invalid-dir' } {
  const target = targetDir.trim()
  if (!path.isAbsolute(target)) return { ok: false, error: 'invalid-dir' }
  const current = memoryRoot()
  if (path.resolve(target) === path.resolve(current)) return { ok: false, error: 'same-path' }
  const defaultRoot = path.join(app.getPath('userData'), 'memory')
  if (path.resolve(target) === path.resolve(defaultRoot)) return { ok: false, error: 'default-target' }
  try {
    mkdirSync(target, { recursive: true })
    // 可写试探 + 空目录检查：覆盖别人已有的记忆数据不可接受。
    const probe = path.join(target, '.memory-write-probe')
    writeFileSync(probe, 'probe', 'utf-8')
    rmSync(probe)
    const existing = readdirSync(target)
    if (existing.length > 0) return { ok: false, error: 'not-empty' }
    if (migrate && existsSync(current)) {
      cpSync(current, target, { recursive: true })
    }
    setStore('memoryStoragePath', target)
    return { ok: true, path: target }
  } catch {
    return { ok: false, error: 'not-writable' }
  }
}

export function resetMemoryStorageToDefault(migrate: boolean): { ok: true } | { ok: false; error: 'not-empty' | 'not-writable' } {
  const defaultRoot = path.join(app.getPath('userData'), 'memory')
  const current = memoryRoot()
  if (path.resolve(current) === path.resolve(defaultRoot)) return { ok: true }
  try {
    mkdirSync(defaultRoot, { recursive: true })
    const existing = readdirSync(defaultRoot)
    if (migrate && existing.length > 0) return { ok: false, error: 'not-empty' }
    if (migrate && existsSync(current)) {
      cpSync(current, defaultRoot, { recursive: true })
    }
    setStore('memoryStoragePath', '')
    return { ok: true }
  } catch {
    return { ok: false, error: 'not-writable' }
  }
}

/**
 * The system-prompt block for one project: global layer first, then the
 * project layer, newest last. A byte budget bounds the block (学 dsh 的
 * instruction budget); overflow drops OLDEST entries first and says so.
 */
const MAX_MEMORY_PROMPT_BYTES = 32 * 1024

export function buildMemoryPrompt(cwd: string, language: 'zh' | 'en' = 'zh'): string | null {
  const projectKey = projectMemoryKey(cwd)
  const globalLayer = readMemoryLayer('global', null)
  const projectLayer = readMemoryLayer('project', projectKey)
  if (globalLayer.entries.length === 0 && projectLayer.entries.length === 0) return null
  const zh = language !== 'en'
  const header = zh
    ? '## 长期记忆（跨对话保留；全局对所有项目生效，项目记忆仅本项目可见）'
    : '## Long-term memory (kept across conversations; global applies to every project, project memory is local to this one)'
  const render = (label: string, entries: MemoryEntry[]) =>
    entries.length === 0
      ? []
      : [`${zh ? '【' + label + '】' : '[' + label + ']'}`].concat(
          entries.map((entry) => `- ${entry.text.replace(/\s+/g, ' ').trim()}`)
        )
  const lines = [
    header,
    ...render(zh ? '全局' : 'Global', globalLayer.entries),
    ...render(zh ? '本项目' : 'This project', projectLayer.entries),
    zh
      ? '（以上是用户此前让你记住的内容，按长期有效的指示对待；与当前任务冲突时先问用户。写入新记忆用 toushou_memory_save 工具。）'
      : '(The user asked you to remember these. Treat them as standing instructions; ask first when they conflict with the current task. Use the toushou_memory_save tool to add new ones.)'
  ]
  let block = lines.join('\n')
  if (Buffer.byteLength(block, 'utf8') <= MAX_MEMORY_PROMPT_BYTES) return block
  // Budget overflow: drop oldest entries (global first) until it fits.
  const keptGlobal: MemoryEntry[] = []
  const keptProject: MemoryEntry[] = []
  let budget = MAX_MEMORY_PROMPT_BYTES
  const cost = (list: MemoryEntry[]) =>
    Buffer.byteLength(list.map((entry) => `- ${entry.text.replace(/\s+/g, ' ').trim()}`).join('\n') + 40, 'utf8')
  // Newest first, keep while the budget holds; then re-render oldest-last.
  const newestFirst = [...globalLayer.entries].reverse()
  for (const entry of newestFirst) {
    const candidate = [...keptGlobal, entry]
    if (cost(candidate) + cost(keptProject) > budget) break
    keptGlobal.push(entry)
  }
  for (const entry of [...projectLayer.entries].reverse()) {
    const candidate = [...keptProject, entry]
    if (cost(keptGlobal) + cost(candidate) > budget) break
    keptProject.push(entry)
  }
  const dropped = globalLayer.entries.length - keptGlobal.length + projectLayer.entries.length - keptProject.length
  block = [
    header,
    ...render(zh ? '全局' : 'Global', keptGlobal.reverse()),
    ...render(zh ? '本项目' : 'This project', keptProject.reverse()),
    zh ? `（其余 ${dropped} 条较旧记忆因空间限制未注入，可在设置中查看。）` : `(${dropped} older memories omitted for space; see Settings.)`
  ].join('\n')
  return block
}
