import { execFile } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  CheckpointDiff,
  CheckpointDiffFile,
  CheckpointInfo,
  CheckpointRestoreResult,
  PackageActionResult
} from '../shared/types'

/**
 * Git-snapshot checkpoints.
 *
 * pi has no checkpoint/rewind feature, so a checkpoint is a dangling git
 * commit holding the full worktree tree, created with a throwaway
 * GIT_INDEX_FILE — the user's own index, stash, refs and worktree are never
 * touched. Restore rewrites tracked files from the commit and deletes files
 * the agent created afterwards (untracked then, gone now).
 */

const execFileAsync = promisify(execFile)

/** Commits made by commit-tree need an identity; never rely on user config. */
const CHECKPOINT_GIT_ENV = {
  GIT_AUTHOR_NAME: '投手',
  GIT_AUTHOR_EMAIL: 'toushou@localhost',
  GIT_COMMITTER_NAME: '投手',
  GIT_COMMITTER_EMAIL: 'toushou@localhost'
}

interface GitResult {
  stdout: string
  stderr: string
}

async function git(projectDir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return execFileAsync('git', args, {
    cwd: projectDir,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024
  }) as Promise<GitResult>
}

async function isGitRepo(projectDir: string): Promise<boolean> {
  try {
    const { stdout } = await git(projectDir, ['rev-parse', '--is-inside-work-tree'])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function headSha(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await git(projectDir, ['rev-parse', '--verify', 'HEAD'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Untracked (non-ignored) files, NUL-separated so special chars survive. */
async function listUntracked(projectDir: string): Promise<string[]> {
  const { stdout } = await git(projectDir, ['ls-files', '-o', '--exclude-standard', '-z'])
  return stdout.split('\0').filter(Boolean)
}

/**
 * Snapshot the worktree of projectDir. Returns the dangling commit sha and
 * the untracked files present at snapshot time, or null when projectDir is
 * not inside a git repository.
 */
export async function createCheckpoint(
  projectDir: string
): Promise<{ sha: string; untracked: string[] } | null> {
  if (!(await isGitRepo(projectDir))) return null

  // Stage everything into a temporary index, never the user's real one.
  const tmp = mkdtempSync(path.join(tmpdir(), 'omp-checkpoint-'))
  const indexEnv = { GIT_INDEX_FILE: path.join(tmp, 'index') }
  try {
    const head = await headSha(projectDir)
    await git(projectDir, ['read-tree', ...(head ? [head] : ['--empty'])], indexEnv)
    await git(projectDir, ['add', '-A'], indexEnv)
    const { stdout: tree } = await git(projectDir, ['write-tree'], indexEnv)
    const { stdout: sha } = await git(
      projectDir,
      ['commit-tree', tree.trim(), ...(head ? ['-p', head] : []), '-m', 'omp-checkpoint'],
      { ...indexEnv, ...CHECKPOINT_GIT_ENV }
    )
    const untracked = await listUntracked(projectDir)
    return { sha: sha.trim(), untracked }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Restore projectDir to a checkpoint: tracked files go back to the snapshot,
 * files created by the agent since (untracked now, but not at checkpoint
 * time) are deleted along with directories left empty. Untracked files that
 * already existed at checkpoint time are kept.
 */
export async function restoreCheckpoint(
  projectDir: string,
  sha: string,
  untrackedAtCheckpoint: string[]
): Promise<PackageActionResult> {
  if (!(await isGitRepo(projectDir))) {
    return { ok: false, log: 'Not a git repository.' }
  }
  const log: string[] = []
  try {
    await git(projectDir, ['restore', `--source=${sha}`, '--worktree', '--', '.'])
    log.push('Restored tracked files from checkpoint.')

    const keep = new Set(untrackedAtCheckpoint)
    const created = (await listUntracked(projectDir)).filter((f) => !keep.has(f))
    for (const rel of created) {
      const abs = path.resolve(projectDir, rel)
      // Guard: only unlink regular files inside the project, never .git.
      if (!abs.startsWith(path.resolve(projectDir) + path.sep)) continue
      if (abs.split(path.sep).includes('.git')) continue
      try {
        unlinkSync(abs)
        log.push(`Deleted ${rel}`)
      } catch {
        // Already gone (e.g. removed by the restore) — fine.
      }
      removeEmptyDirs(path.dirname(abs), projectDir)
    }
    return { ok: true, log: log.join('\n') }
  } catch (err) {
    return { ok: false, log: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Restore projectDir to a checkpoint, reversibly. BEFORE the worktree is
 * overwritten, its current state is snapshotted and persisted as a linked
 * `pre-undo` checkpoint (never listed as a turn checkpoint), so undoing an
 * undo — redo — always has a target and the agent's work is never destroyed
 * by a misclick. The safety snapshot is best-effort: outside a git repo the
 * restore still runs, it just cannot be redone.
 */
export interface ReversibleRestoreInput {
  sessionId: string
  projectDir: string
  /** The checkpoint being restored to. */
  targetSha: string
  targetUntracked: string[]
  /** Inherited by the pre-undo entry so the store stays uniform. */
  msgIndex: number
  /** Injectable persistence path for tests; production uses the default. */
  storeFile?: string
}

export async function restoreCheckpointReversible(
  input: ReversibleRestoreInput
): Promise<CheckpointRestoreResult> {
  // 1. Snapshot the CURRENT worktree first — after the restore the agent's
  // post-turn state would already be gone.
  const snapshot = await createCheckpoint(input.projectDir)
  let preUndoCheckpointId: string | undefined
  if (snapshot) {
    const entry: CheckpointInfo = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      sha: snapshot.sha,
      untracked: snapshot.untracked,
      promptPreview: '',
      msgIndex: input.msgIndex,
      createdAt: Date.now(),
      kind: 'pre-undo'
    }
    saveCheckpoint(entry, input.storeFile)
    preUndoCheckpointId = entry.id
  }
  // 2. Only then mutate the worktree.
  const result = await restoreCheckpoint(input.projectDir, input.targetSha, input.targetUntracked)
  if (!result.ok) return result
  return { ...result, preUndoCheckpointId }
}

/** Remove dirs made empty by deleted agent files, stopping at projectDir. */
function removeEmptyDirs(dir: string, projectDir: string): void {
  const root = path.resolve(projectDir)
  let current = dir
  while (current.startsWith(root + path.sep)) {
    if (current.split(path.sep).includes('.git')) return
    try {
      // rmdir only succeeds on empty directories; stop when one isn't.
      rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

// ---------------------------------------------------------------------------
// Diff (checkpoint snapshot vs the current worktree)
// ---------------------------------------------------------------------------

/**
 * Parse `git diff --name-status -z` output into renderer-friendly statuses.
 * Records are NUL-separated: `<status>\0<path>\0`, with a second path for
 * renames/copies (`R100\0<old>\0<new>\0`). Rename/copy and type changes
 * degrade to "modified" on the path that exists in the worktree now.
 * Exported for tests; pure.
 */
export function parseNameStatusZ(
  stdout: string
): { path: string; status: CheckpointDiffFile['status'] }[] {
  const tokens = stdout.split('\0')
  const files: { path: string; status: CheckpointDiffFile['status'] }[] = []
  let i = 0
  while (i < tokens.length) {
    const statusToken = tokens[i]
    i += 1
    // Trailing NUL leaves one empty token at the end; just skip it.
    if (!statusToken) continue
    const pathA = tokens[i] ?? ''
    i += 1
    const code = statusToken[0]
    if (code === 'A') {
      files.push({ path: pathA, status: 'added' })
    } else if (code === 'D') {
      files.push({ path: pathA, status: 'deleted' })
    } else if (code === 'R' || code === 'C') {
      const pathB = tokens[i] ?? ''
      i += 1
      files.push({ path: pathB || pathA, status: 'modified' })
    } else {
      // M (modified) and T (type change); anything unexpected degrades to it.
      files.push({ path: pathA, status: 'modified' })
    }
  }
  return files
}

/**
 * Parse one plain `git diff --numstat` line: `<added>\t<deleted>\t<path>`.
 * Binary files print `-` for both counts (mapped to null). Pure; exported
 * for tests.
 */
export function parseNumstatLine(
  line: string
): { additions: number | null; deletions: number | null; path: string } | null {
  const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
  if (!match) return null
  return {
    additions: match[1] === '-' ? null : Number.parseInt(match[1], 10),
    deletions: match[2] === '-' ? null : Number.parseInt(match[2], 10),
    path: match[3]
  }
}

/**
 * Per-turn change summary: everything that differs between a checkpoint
 * snapshot and the CURRENT worktree. Plain `git diff <sha>` would miss the
 * agent's newly created files (untracked, invisible to the index), so — like
 * createCheckpoint — the worktree is first staged into a throwaway index and
 * written to a tree; the comparison is then tree-to-tree and complete.
 * Returns null outside a git repo or when the diff cannot be produced
 * (e.g. the dangling snapshot was garbage-collected). Computed lazily per
 * request; never touches the user's own index.
 */
export async function diffCheckpoint(projectDir: string, sha: string): Promise<CheckpointDiff | null> {
  if (!(await isGitRepo(projectDir))) return null
  const tmp = mkdtempSync(path.join(tmpdir(), 'omp-checkpoint-diff-'))
  const indexEnv = { GIT_INDEX_FILE: path.join(tmp, 'index') }
  try {
    const head = await headSha(projectDir)
    await git(projectDir, ['read-tree', ...(head ? [head] : ['--empty'])], indexEnv)
    await git(projectDir, ['add', '-A'], indexEnv)
    const { stdout: tree } = await git(projectDir, ['write-tree'], indexEnv)
    const current = tree.trim()
    // quotepath=false keeps non-ASCII paths raw so numstat lines match the
    // authoritative -z name-status paths.
    const [nameStatus, numstat] = await Promise.all([
      git(projectDir, ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z', sha, current]),
      git(projectDir, ['-c', 'core.quotepath=false', 'diff', '--numstat', sha, current])
    ])
    const counts = new Map<string, { additions: number | null; deletions: number | null }>()
    let additions = 0
    let deletions = 0
    for (const line of numstat.stdout.split('\n')) {
      const parsed = parseNumstatLine(line)
      if (!parsed) continue
      if (parsed.additions !== null) additions += parsed.additions
      if (parsed.deletions !== null) deletions += parsed.deletions
      counts.set(parsed.path, { additions: parsed.additions, deletions: parsed.deletions })
    }
    return {
      files: parseNameStatusZ(nameStatus.stdout).map((f) => ({
        ...f,
        ...(counts.get(f.path) ?? { additions: null, deletions: null })
      })),
      additions,
      deletions
    }
  } catch {
    // Snapshot garbage-collected, racing edit, broken repo — no summary.
    return null
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Persistence (userData/checkpoints.json, injectable for tests)
// ---------------------------------------------------------------------------

function defaultStoreFile(): string {
  return path.join(app.getPath('userData'), 'checkpoints.json')
}

function readStore(file: string): CheckpointInfo[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(raw) ? (raw as CheckpointInfo[]) : []
  } catch {
    return []
  }
}

function writeStore(file: string, entries: CheckpointInfo[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(entries, null, 2))
}

/** Append a checkpoint to the persistent store. */
export function saveCheckpoint(entry: CheckpointInfo, file?: string): void {
  const target = file ?? defaultStoreFile()
  writeStore(target, [...readStore(target), entry])
}

/**
 * Legacy store entries predate the `kind` field and are always turn
 * checkpoints; only explicit `pre-undo` entries are safety snapshots.
 */
function isTurnCheckpoint(entry: CheckpointInfo): boolean {
  return (entry.kind ?? 'turn') === 'turn'
}

/**
 * A session's turn checkpoints (oldest first). `pre-undo` entries are
 * deliberately filtered out — they are internal redo targets, not turn
 * snapshots, and must never appear as restore candidates in the transcript
 * UI or the message rollback menu.
 */
export function listCheckpoints(sessionId: string, file?: string): CheckpointInfo[] {
  return readStore(file ?? defaultStoreFile()).filter(
    (c) => c.sessionId === sessionId && isTurnCheckpoint(c)
  )
}

export function getCheckpoint(id: string, file?: string): CheckpointInfo | null {
  return readStore(file ?? defaultStoreFile()).find((c) => c.id === id) ?? null
}
