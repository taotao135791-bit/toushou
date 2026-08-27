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
import { CheckpointInfo, PackageActionResult } from '../shared/types'

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
  GIT_AUTHOR_NAME: 'AdPilot',
  GIT_AUTHOR_EMAIL: 'adpilot@localhost',
  GIT_COMMITTER_NAME: 'AdPilot',
  GIT_COMMITTER_EMAIL: 'adpilot@localhost'
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

export function listCheckpoints(sessionId: string, file?: string): CheckpointInfo[] {
  return readStore(file ?? defaultStoreFile()).filter((c) => c.sessionId === sessionId)
}

export function getCheckpoint(id: string, file?: string): CheckpointInfo | null {
  return readStore(file ?? defaultStoreFile()).find((c) => c.id === id) ?? null
}
