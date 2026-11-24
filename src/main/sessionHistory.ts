import { lstat, open, readdir, stat, unlink } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { defaultPiAgentDir } from './piSettings'
import { canonicalExistingPath } from './canonicalPath'
import type { SessionImportSource } from '../shared/sessionImport'

/**
 * Main-only record discovered from a durable session file.
 *
 * `filePath` is deliberately kept out of the shared renderer contract. It is
 * converted into an opaque HistorySessionDescriptor by HistorySessionGrantManager
 * before crossing IPC.
 */
export interface HistorySessionFile {
  /** Session uuid from the file header. */
  uuid: string
  /** Main-only canonical candidate path for the durable JSONL file. */
  filePath: string
  /**
   * The runtime's own persisted title record (renames, task names) when the
   * file has one, else the first user message. Truncated to 80 chars;
   * 'Untitled' when neither exists.
   */
  title: string
  /** Session start time, epoch ms. */
  timestamp: number
  /** Header metadata; informational only and never trusted for authorization. */
  cwd: string
  /**
   * Annotated by the IPC layer from Main's session-origin index (the durable
   * file itself carries no provenance) so minted descriptors can badge rows.
   */
  origin?: 'feishu' | 'task'
  importedFrom?: SessionImportSource
}

/**
 * Read-only access to pi's on-disk session files:
 * <agentDir>/sessions/<dirName>/<fileTimestamp>_<uuid>.jsonl
 *
 * dirName encodes the session's cwd (pi session-manager.js):
 *   `--${resolvedCwd.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`
 * where resolvedCwd is the realpath of the cwd (/tmp → /private/tmp on macOS).
 *
 * The file opens with an optional {"type":"title",…} line (current omp),
 * then the {"type":"session","id","timestamp","cwd"} header, followed by
 * entries such as {"type":"message","message":<AgentMessage>}.
 */

/** Bytes of a session file scanned for the first user message (title source). */
const TITLE_SCAN_BYTES = 256 * 1024

/** Bytes scanned for the session header line (uuid source for delete). */
const HEADER_SCAN_BYTES = 64 * 1024

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/

/** Title fallback for sessions without a user message. */
const UNTITLED = 'Untitled'

export function sessionsRoot(agentDir: string = defaultPiAgentDir()): string {
  return path.join(agentDir, 'sessions')
}

/** pi's session directory for a project cwd (see header for the encoding). */
export function sessionDirFor(projectDir: string, agentDir: string = defaultPiAgentDir(), resolveRealPath: (target: string) => string = realpathSync): string {
  let resolved: string
  try {
    resolved = resolveRealPath(projectDir)
  } catch {
    resolved = path.resolve(projectDir)
  }
  const dirName = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return path.join(sessionsRoot(agentDir), dirName)
}

/**
 * OMP 17 stores sessions using a home-relative slug on macOS/Linux:
 *   /Users/me/project → -project
 *   /tmp/project      → -tmp-project
 *
 * Older pi/OMP builds used the `--<absolute-path>--` form implemented by
 * sessionDirFor(). Keep that function as the legacy-compatible helper used by
 * existing callers/tests, but discover both layouts when reading history.
 */
export function currentSessionDirFor(
  projectDir: string,
  agentDir: string = defaultPiAgentDir(),
  resolveRealPath: (target: string) => string = realpathSync
): string {
  let resolved: string
  try {
    resolved = resolveRealPath(projectDir)
  } catch {
    resolved = path.resolve(projectDir)
  }

  // macOS reports /private/tmp and /tmp as the same real directory. OMP
  // normalizes that alias before deriving its slug; mirror it here so a GUI
  // workspace grant and the runtime's durable directory agree.
  if (process.platform === 'darwin' && resolved.startsWith('/private/')) {
    const withoutPrivate = resolved.slice('/private'.length)
    try {
      if (resolveRealPath(resolved) === resolveRealPath(withoutPrivate)) resolved = withoutPrivate
    } catch {
      // Keep the validated realpath when the alias cannot be checked.
    }
  }

  const home = (() => {
    try {
      return resolveRealPath(homedir())
    } catch {
      return path.resolve(homedir())
    }
  })()
  const relative = path.relative(home, resolved)
  const slug =
    relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative
      : resolved.replace(/^[/\\]/, '')
  return path.join(sessionsRoot(agentDir), `-${slug.replace(/[/\\:]/g, '-')}`)
}

/** All known OMP/pi session directory layouts, newest layout first. */
export function sessionDirCandidatesFor(
  projectDir: string,
  agentDir: string = defaultPiAgentDir()
): string[] {
  // Windows Node's JS and native realpath implementations can retain different
  // short/long spellings. Keep layouts from both for the same trusted workspace;
  // a runtime upgrade must not hide its existing transcripts.
  const native = (target: string) => realpathSync.native(target)
  return Array.from(
    new Set([
      ...hashedSessionDirCandidatesFor(projectDir, agentDir),
      ...ompSessionDirCandidatesFor(projectDir, agentDir, realpathSync),
      currentSessionDirFor(projectDir, agentDir),
      sessionDirFor(projectDir, agentDir),
      ...(process.platform === 'win32' ? [
        ...hashedSessionDirCandidatesFor(projectDir, agentDir, native),
        ...ompSessionDirCandidatesFor(projectDir, agentDir, native),
        currentSessionDirFor(projectDir, agentDir, native),
        sessionDirFor(projectDir, agentDir, native)
      ] : [])
    ])
  )
}

/**
 * The runtime keeps only ASCII word characters (plus dot/dash) in a hashed
 * directory's label. A label that sanitizes away entirely — pure-CJK basenames
 * such as 投手工作区 — is written as `project` (verified on disk: three
 * distinct CJK projects all map to `home-project-<sha256(realpath)>`, and the
 * root path `/` maps to `abs-project-<sha256('/')>`). Mirror that here so the
 * GUI's candidates match runtime-written directories for non-ASCII projects.
 */
function hashLabelCandidates(rawLabel: string): string[] {
  const sanitized = rawLabel.replace(/[^\w.-]/g, '')
  return sanitized ? [rawLabel, sanitized] : [rawLabel, 'project']
}

/**
 * Current OMP layout (verified against 17.2.x on-disk state): directories are
 * named `<zone>-<label>-<sha256(realpath)>` where zone is `home` (project
 * inside $HOME) or `abs` (outside $HOME). Current runtimes label both zones
 * with the project basename; retain the earlier relative-path label too.
 * Example:
 *   /Users/me/…/toushou → home-toushou-4072a02833…
 * The label is ASCII-sanitized by the runtime (see hashLabelCandidates), so
 * both the raw and the sanitized form are returned as candidates.
 * Older builds used the slug forms above; keep every candidate so listing,
 * resume and delete authority keep working across runtime upgrades.
 */
export function hashedSessionDirCandidatesFor(
  projectDir: string,
  agentDir: string = defaultPiAgentDir(),
  resolveRealPath: (target: string) => string = realpathSync
): string[] {
  let resolved: string
  try {
    resolved = resolveRealPath(projectDir)
  } catch {
    resolved = path.resolve(projectDir)
  }
  const hash = createHash('sha256').update(resolved).digest('hex')
  const home = (() => {
    try {
      return resolveRealPath(homedir())
    } catch {
      return path.resolve(homedir())
    }
  })()
  const relative = path.relative(home, resolved)
  const inHome = !relative.startsWith('..') && !path.isAbsolute(relative)
  const rawLabel = inHome
    ? path.basename(resolved)
    : (relative === '' ? path.basename(resolved) : relative).replace(/^[/\\]/, '')
  const zone = inHome ? 'home' : 'abs'
  const labels = new Set([...hashLabelCandidates(rawLabel), ...hashLabelCandidates(path.basename(resolved))])
  return [...labels].map((label) =>
    path.join(sessionsRoot(agentDir), `${zone}-${label}-${hash}`)
  )
}

/** OMP 17.2.12 default and its 17.2.5–17.2.8 hashed migration source. */
export function ompSessionDirCandidatesFor(
  projectDir: string,
  agentDir: string,
  resolveRealPath: (target: string) => string
): string[] {
  const resolve = (target: string): string => {
    const absolute = path.resolve(target)
    try { return resolveRealPath(absolute) } catch { return absolute }
  }
  const cwd = resolve(projectDir)
  const homeRelative = path.relative(resolve(homedir()), cwd)
  const tempRelative = path.relative(resolve(tmpdir()), cwd)
  const inside = (relative: string): boolean => relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  let scope: 'home' | 'tmp' | 'abs'
  let encoded: string
  const encodeRelative = (prefix: string, relative: string): string => {
    const slug = relative.replace(/[/\\:]/g, '-')
    return slug ? (prefix.endsWith('-') ? `${prefix}${slug}` : `${prefix}-${slug}`) : prefix
  }
  if (inside(homeRelative)) {
    scope = 'home'
    encoded = encodeRelative('-', homeRelative)
  } else if (inside(tempRelative)) {
    scope = 'tmp'
    encoded = encodeRelative('-tmp', tempRelative)
  } else {
    scope = 'abs'
    encoded = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  }
  const label = path.basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'project'
  const hash = createHash('sha256').update(cwd.replaceAll('\\', '/')).digest('hex')
  return [path.join(sessionsRoot(agentDir), encoded), path.join(sessionsRoot(agentDir), `${scope}-${label}-${hash}`)]
}

/**
 * List EVERY session file across all projects and layout generations,
 * newest first, capped to the newest `limit` entries. Layout-agnostic by
 * construction (walks the sessions root) — this is what the sidebar's
 * cross-project history needs; per-directory slug guessing cannot keep up
 * with runtime renames.
 */
export async function listAllSessions(
  agentDir: string = defaultPiAgentDir(),
  limit = 300
): Promise<HistorySessionFile[]> {
  const root = sessionsRoot(agentDir)
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return []
  }
  const out: HistorySessionFile[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(path.join(root, dir))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const info = await parseSessionFile(path.join(root, dir, name))
      if (info) out.push(info)
    }
  }
  out.sort((a, b) => b.timestamp - a.timestamp)
  // Runtime headers may use an alias (/tmp versus /private/tmp, or a project
  // symlink), while recent workspaces use Main's canonical path. Normalize
  // display metadata here so the renderer can match the exact project without
  // guessing paths. This does not mint authority: resume still revalidates the
  // workspace grant and its session capability in Main.
  const paths = new Map<string, string>()
  return out.slice(0, limit).map(entry => {
    if (!path.isAbsolute(entry.cwd)) return entry
    let canonical = paths.get(entry.cwd)
    if (!canonical) {
      // Match the native canonical path used by workspace grants, including
      // Windows short/long aliases. Missing directories keep their metadata.
      try { canonical = canonicalExistingPath(entry.cwd) } catch { canonical = entry.cwd }
      paths.set(entry.cwd, canonical)
    }
    return { ...entry, cwd: canonical }
  })
}

/**
 * Guard for destructive/resume operations: the resolved path must be a
 * .jsonl file inside the sessions root (any project's directory within it),
 * and — crucially — its REAL path must also land inside the sessions root, so a
 * `session.jsonl -> /outside/file` symlink can never be read/resumed as a
 * transcript (or deleted through to its outside target).
 */
export function isSessionFilePath(
  filePath: string,
  agentDir: string = defaultPiAgentDir()
): boolean {
  if (typeof filePath !== 'string' || !filePath.endsWith('.jsonl')) return false
  const root = path.resolve(sessionsRoot(agentDir))
  const resolved = path.resolve(filePath)
  // The sessions root may itself sit behind a junction/symlink (e.g. a
  // redirected %USERPROFILE%\.omp on Windows): callers hand us canonical
  // realpaths of files under that root, so accept containment under either
  // the lexical root or its canonical real form. Fast lexical reject first.
  let rootReal = root
  try {
    rootReal = realpathSync(root)
  } catch {
    // Missing/unresolvable root: the lexical form is all the evidence there is.
  }
  const under = (base: string, candidate: string) =>
    candidate === base || candidate.startsWith(base + path.sep)
  if (!under(root, resolved) && !(rootReal !== root && under(rootReal, resolved))) return false
  // Realpath containment: when the file exists, its real path must stay inside
  // the real sessions root — a `session.jsonl -> /outside/file` symlink is rejected.
  // A missing/broken target has nothing to follow (no symlink-escape risk), so
  // the lexical check above already suffices there.
  try {
    const fileReal = realpathSync(resolved)
    return under(rootReal, fileReal)
  } catch {
    return true
  }
}

/** Read at most `bytes` from the start of a file. */
async function readHead(filePath: string, bytes: number): Promise<string> {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.toString('utf-8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Read at most `bytes` from the END of a file (the first line may be partial;
 * callers tolerating that skip it). Used to find the last message timestamp.
 */
async function readTail(filePath: string, bytes: number): Promise<string> {
  const fh = await open(filePath, 'r')
  try {
    const size = (await fh.stat()).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf-8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Bytes of the file tail scanned for the last message timestamp. */
const LAST_MESSAGE_SCAN_BYTES = 256 * 1024

/**
 * Timestamp of the last MESSAGE entry in the file. Message entries are the
 * only records that exist purely because someone interacted — title lines and
 * metadata records can be appended by opening/resuming machinery, so using
 * them (or mtime) made a merely-opened conversation jump to the top of the
 * list ("一点进去就被激活"). Null when the tail holds no message timestamp;
 * callers fall back to mtime.
 */
async function lastMessageTimestamp(filePath: string): Promise<number | null> {
  let tail: string
  try {
    tail = await readTail(filePath, LAST_MESSAGE_SCAN_BYTES)
  } catch {
    return null
  }
  const lines = tail.split('\n')
  // A resumed/forked file can exceed the scan window on huge conversations:
  // walk backward and take the first parseable message entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"message"')) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as { type?: unknown; timestamp?: unknown }
      if (record.type !== 'message') continue
      const ts = typeof record.timestamp === 'number' ? record.timestamp : typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
      if (Number.isFinite(ts)) return ts
    } catch {
      // partial first line of the window or non-JSON — keep walking back
    }
  }
  return null
}

/** Join the text blocks of an AgentMessage content array (or plain string). */
function textContentOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Parse one session file: the session header for id/timestamp/cwd, then the
 * persisted title record (preferred) or the first user message (within
 * TITLE_SCAN_BYTES) for the title. Returns null for files without a parseable
 * session header.
 *
 * Header position is deliberately not pinned to line 0: legacy pi opens the
 * file with {"type":"session",…} directly, current omp prepends a
 * {"type":"title",…} line. Scan the first few lines for the header instead.
 * The title record is rewritten in place by the runtime (it carries a `pad`
 * field exactly for that), so reading it from the head always yields the
 * CURRENT title — honoring it keeps task names and user renames visible after
 * a restart instead of degrading every row to its first prompt text.
 */
async function parseSessionFile(filePath: string): Promise<HistorySessionFile | null> {
  let head: string
  try {
    head = await readHead(filePath, TITLE_SCAN_BYTES)
  } catch {
    return null
  }
  const lines = head.split('\n')
  let header: { id: string; timestamp?: unknown; cwd?: unknown; importedFrom?: unknown } | null = null
  let headerIndex = -1
  let recordedTitle = ''
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (!lines[i].trim()) continue
    let candidate: {
      type?: unknown
      id?: unknown
      timestamp?: unknown
      cwd?: unknown
      title?: unknown
      importedFrom?: unknown
    }
    try {
      candidate = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (candidate?.type === 'title' && typeof candidate.title === 'string') {
      const trimmed = candidate.title.replace(/\s+/g, ' ').trim()
      if (trimmed && !recordedTitle) recordedTitle = trimmed.slice(0, 80)
      continue
    }
    if (candidate?.type === 'session' && typeof candidate.id === 'string') {
      header = { id: candidate.id, timestamp: candidate.timestamp, cwd: candidate.cwd, importedFrom: candidate.importedFrom }
      if (!recordedTitle && typeof candidate.title === 'string') {
        recordedTitle = candidate.title.replace(/\s+/g, ' ').trim().slice(0, 80)
      }
      headerIndex = i
      break
    }
  }
  if (!header) return null

  let timestamp =
    typeof header.timestamp === 'number' ? header.timestamp : Date.parse(String(header.timestamp))
  if (!Number.isFinite(timestamp)) timestamp = 0
  // Recency = LAST MESSAGE time, not session start and not mtime: live rows
  // order by last activity, and only real interaction adds messages. Open/
  // resume machinery (title lines, metadata records, file touches) must not
  // reorder the list — that read as "一点进去就被激活". Start time stays the
  // floor; mtime is the last resort for files whose tail has no timestamps.
  const lastMessage = await lastMessageTimestamp(filePath)
  if (lastMessage !== null && lastMessage > timestamp) timestamp = lastMessage
  if (timestamp === 0) {
    timestamp = await stat(filePath).then((s) => s.mtimeMs, () => 0)
  }

  let title = recordedTitle || UNTITLED
  if (!recordedTitle) {
    for (const line of lines.slice(headerIndex + 1)) {
      if (!line.trim()) continue
      let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry?.type === 'message' && entry.message?.role === 'user') {
        const text = textContentOf(entry.message.content).replace(/\s+/g, ' ').trim()
        if (text) {
          title = text.slice(0, 80)
          break
        }
      }
    }
  }

  return {
    uuid: header.id,
    filePath,
    title,
    timestamp,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    ...(header.importedFrom === 'codex' || header.importedFrom === 'claude' ? { importedFrom: header.importedFrom } : {})
  }
}

/**
 * List persisted sessions of a project, newest first.
 * Returns [] when the project has no session directory.
 */
export async function listSessionHistory(
  projectDir: string,
  agentDir?: string
): Promise<HistorySessionFile[]> {
  const out: HistorySessionFile[] = []
  const seenFiles = new Set<string>()
  for (const dir of sessionDirCandidatesFor(projectDir, agentDir)) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const filePath = path.join(dir, name)
      if (seenFiles.has(filePath)) continue
      seenFiles.add(filePath)
      const info = await parseSessionFile(filePath)
      if (info) out.push(info)
    }
  }
  out.sort((a, b) => b.timestamp - a.timestamp)
  return out
}

/** Session uuid shape accepted for uuid-keyed resolution (runtime uuids and test ids). */
const SESSION_UUID_RE = /^[0-9a-zA-Z-]{1,128}$/

export function isSessionUuid(uuid: unknown): uuid is string {
  return typeof uuid === 'string' && !CONTROL_CHARS_RE.test(uuid) && SESSION_UUID_RE.test(uuid)
}

/**
 * Parse the session uuid from a file's header without reading the whole
 * transcript. Returns null for files without a parseable session header.
 */
export async function readSessionUuid(filePath: string): Promise<string | null> {
  let head: string
  try {
    head = await readHead(filePath, HEADER_SCAN_BYTES)
  } catch {
    return null
  }
  for (const line of head.split('\n').slice(0, 5)) {
    if (!line.trim()) continue
    try {
      const candidate: unknown = JSON.parse(line)
      if (
        candidate &&
        typeof candidate === 'object' &&
        (candidate as { type?: unknown }).type === 'session' &&
        typeof (candidate as { id?: unknown }).id === 'string'
      ) {
        return (candidate as { id: string }).id
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Resolve a durable session uuid to EVERY transcript file under the sessions
 * root, across all project directories and layout generations. Directory-name
 * candidates can never be exhaustive (the runtime renamed layouts across
 * versions and sanitizes labels), so copy-proof delete walks the root instead.
 */
export async function findSessionFilesByUuid(
  uuid: string,
  agentDir: string = defaultPiAgentDir()
): Promise<string[]> {
  if (!isSessionUuid(uuid)) return []
  const root = sessionsRoot(agentDir)
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return []
  }
  const matches: string[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(path.join(root, dir))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const filePath = path.join(root, dir, name)
      if ((await readSessionUuid(filePath)) === uuid) matches.push(filePath)
    }
  }
  return matches
}

/**
 * Delete EVERY durable copy of a session uuid (any project dir, any layout
 * generation) inside the guarded sessions root. Resolves the files by header
 * uuid — not by directory-name guessing — so a delete can never leave a
 * legacy-layout or sanitized-label copy behind for the scanner to resurrect.
 * Returns true only when the uuid no longer resolves anywhere; a uuid that
 * is already fully deleted also reports true (nothing left to remove).
 */
export async function deleteSessionCopiesByUuid(
  uuid: string,
  agentDir: string = defaultPiAgentDir()
): Promise<boolean> {
  if (!isSessionUuid(uuid)) return false
  for (const copy of await findSessionFilesByUuid(uuid, agentDir)) {
    // findSessionFilesByUuid only lists .jsonl files inside the sessions root;
    // deleteSessionFile removes a symlinked entry itself, never an outside
    // target, and carries the handle-release retry.
    if (isSessionFilePath(copy, agentDir)) {
      await deleteSessionFile(copy, agentDir, uuid)
    }
  }
  return (await findSessionFilesByUuid(uuid, agentDir)).length === 0
}

/**
 * Copy-proof form of deleteSessionFile: removes the granted file and then
 * sweeps every same-uuid copy (legacy layout, sanitized label, migrated dir).
 * Success requires the uuid to no longer resolve anywhere.
 */
export async function deleteSessionFileEverywhere(
  filePath: string,
  agentDir: string = defaultPiAgentDir(),
  guard?: (uuid: string | null, remove: () => Promise<boolean>) => Promise<boolean | 'locked'>
): Promise<boolean | 'locked'> {
  if (!isSessionFilePath(filePath, agentDir)) return false
  const uuid = await readSessionUuid(filePath)
  const remove = async () => {
    // Delete the granted copy first so it cannot be missed by a walk race,
    // then sweep the other copies and verify nothing resolves anymore.
    await deleteSessionFile(filePath, agentDir, uuid)
    return uuid ? deleteSessionCopiesByUuid(uuid, agentDir) : !(await exists(filePath))
  }
  return guard ? guard(uuid, remove) : remove()
}

/** Delete a session file; guarded to .jsonl files inside the sessions root.
 * A live-session delete kills the runtime first, but Windows releases the
 * file handle asynchronously — the first unlink can land while the dying
 * process (or the AV scanning the changed file) still holds it. Retry briefly
 * before reporting failure; the rollback that a false return triggers makes
 * the row reappear, which users read as "删除不掉" (2026-11-24 实测复现). */
export async function deleteSessionFile(filePath: string, agentDir?: string, expectedUuid?: string | null): Promise<boolean> {
  let original: BigIntStats | undefined
  for (let attempt = 0; ; attempt++) {
    if (!isSessionFilePath(filePath, agentDir)) return false
    let current: BigIntStats
    try {
      current = await lstat(filePath, { bigint: true })
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    if (!current.isFile() && !current.isSymbolicLink()) return false
    if (original && !sameSessionFileIdentity(current, original)) return false
    original ??= current
    if (expectedUuid !== undefined) {
      // A runtime rewrite can put a different conversation at this path,
      // including a same-inode header replacement between Windows retries.
      if (await readSessionUuid(filePath) !== expectedUuid) return false
      try {
        if (!sameSessionFileIdentity(await lstat(filePath, { bigint: true }), original)) return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
      }
    }
    // A waiting retry may see a new file or a redirected parent path.
    if (!isSessionFilePath(filePath, agentDir)) return false
    try {
      await unlink(filePath)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return true
      // Only lock-style failures benefit from waiting; a real denial stays honest.
      if (attempt >= 4 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) return false
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
}

function sameSessionFileIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs
}
