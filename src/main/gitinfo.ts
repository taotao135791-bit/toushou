import { execFile } from 'node:child_process'
import { readFileSync, realpathSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { GitFileChange, GitInfo } from '../shared/types'

/**
 * Working-tree change data for the renderer's "changes" panel,
 * plus per-file diffs. Read-only; shelling out with execFile (no shell).
 */

const execFileAsync = promisify(execFile)

const MAX_DIFF_BYTES = 200 * 1024
const MAX_NEW_FILE_LINES = 400

async function git(projectDir: string, args: string[]): Promise<string> {
  const { stdout } = (await execFileAsync('git', args, {
    cwd: projectDir,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024
  })) as { stdout: string; stderr: string }
  return stdout
}

async function isGitRepo(projectDir: string): Promise<boolean> {
  try {
    return (await git(projectDir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

async function hasHead(projectDir: string): Promise<boolean> {
  try {
    await git(projectDir, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** Branch name, or the short sha when detached. */
async function currentBranch(projectDir: string): Promise<string> {
  const branch = (await git(projectDir, ['branch', '--show-current'])).trim()
  if (branch) return branch
  try {
    return (await git(projectDir, ['rev-parse', '--short', 'HEAD'])).trim()
  } catch {
    return ''
  }
}

interface StatusEntry {
  path: string
  status: GitFileChange['status']
}

/** Parse `git status --porcelain -z` into path/status entries. */
function parsePorcelain(raw: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  const parts = raw.split('\0').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const x = part[0]
    const y = part[1]
    const file = part.slice(3)
    if (x === '?' && y === '?') {
      entries.push({ path: file, status: 'untracked' })
      continue
    }
    if (x === 'R' || y === 'R') {
      // Rename entries carry the source path as an extra NUL-separated field.
      i++
      entries.push({ path: file, status: 'M' })
      continue
    }
    const code = x !== ' ' ? x : y
    entries.push({
      path: file,
      status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M'
    })
  }
  return entries
}

/** Parse `git diff --numstat` output: additions, deletions ('-' for binary), path. */
function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<string, { additions: number | null; deletions: number | null }>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [add, del, ...rest] = line.split('\t')
    const file = rest.join('\t')
    if (!file) continue
    map.set(file, {
      additions: add === '-' ? null : Number(add),
      deletions: del === '-' ? null : Number(del)
    })
  }
  return map
}

/** Change summary for a project; null when projectDir is not a git repo. */
export async function getGitInfo(projectDir: string): Promise<GitInfo | null> {
  if (!(await isGitRepo(projectDir))) return null

  const head = await hasHead(projectDir)
  const [branch, statusRaw, numstatRaw] = await Promise.all([
    currentBranch(projectDir),
    git(projectDir, ['status', '--porcelain', '-z']),
    // Without HEAD nothing is committed; staged entries are the baseline diff.
    head
      ? git(projectDir, ['diff', '--numstat', 'HEAD', '--'])
      : git(projectDir, ['diff', '--numstat', '--cached', '--'])
  ])

  const numstat = parseNumstat(numstatRaw)
  const files: GitFileChange[] = []
  const seen = new Set<string>()
  for (const entry of parsePorcelain(statusRaw)) {
    seen.add(entry.path)
    const counts = numstat.get(entry.path)
    // Untracked files have no numstat row — count their lines for the +N badge.
    const untrackedAdds =
      entry.status === 'untracked' ? countFileLines(projectDir, entry.path) : null
    files.push({
      path: entry.path,
      status: entry.status,
      additions: counts?.additions ?? untrackedAdds,
      deletions: counts?.deletions ?? (entry.status === 'untracked' ? 0 : null)
    })
  }
  // Files in the numstat but not in status (shouldn't happen) — keep them.
  for (const [file, counts] of numstat) {
    if (!seen.has(file)) {
      files.push({ path: file, status: 'M', ...counts })
    }
  }

  let totalAdditions = 0
  let totalDeletions = 0
  for (const f of files) {
    totalAdditions += f.additions ?? 0
    totalDeletions += f.deletions ?? 0
  }
  return { branch, files, totalAdditions, totalDeletions }
}

/** Real path of a file only if it stays inside the project (no symlink escape). */
function safeReadablePath(projectDir: string, relPath: string): string | null {
  const rootReal = safeReal(projectDir)
  if (!rootReal) return null
  const abs = path.resolve(projectDir, relPath)
  const real = safeReal(abs)
  if (!real) return null
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null
  return real
}

function safeReal(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** True when `relPath` is a symlink (for the "symlink → target" presentation). */
function isSymlink(projectDir: string, relPath: string): boolean {
  try {
    return lstatSync(path.resolve(projectDir, relPath)).isSymbolicLink()
  } catch {
    return false
  }
}

/** Line count for an untracked file's +N badge; null for unreadable/binary/huge/escaping files. */
function countFileLines(projectDir: string, relPath: string): number | null {
  const safe = safeReadablePath(projectDir, relPath)
  if (!safe) return null
  try {
    const buf = readFileSync(safe)
    if (buf.length > 2 * 1024 * 1024) return null
    if (buf.includes(0)) return null // binary
    let n = 0
    for (const b of buf) if (b === 10) n++
    return buf.length > 0 && buf[buf.length - 1] !== 10 ? n + 1 : n
  } catch {
    return null
  }
}

/** Resolve user-supplied filePath and refuse anything outside projectDir. */
function resolveInside(projectDir: string, filePath: string): string | null {
  const root = path.resolve(projectDir)
  const abs = path.resolve(root, filePath)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

/**
 * Diff of a single file against HEAD (or the index without HEAD).
 * Untracked files get a synthetic new-file diff. null when the path escapes
 * the project or the project is not a git repo.
 */
export async function getFileDiff(projectDir: string, filePath: string): Promise<string | null> {
  const abs = resolveInside(projectDir, filePath)
  if (!abs) return null
  if (!(await isGitRepo(projectDir))) return null
  const rel = path.relative(path.resolve(projectDir), abs)

  const status = await git(projectDir, ['status', '--porcelain', '-z', '--', rel])
  let diff: string
  if (status.startsWith('??')) {
    diff = synthesizeNewFileDiff(projectDir, rel)
  } else {
    const head = await hasHead(projectDir)
    diff = head
      ? await git(projectDir, ['diff', 'HEAD', '--', rel])
      : await git(projectDir, ['diff', '--cached', '--', rel])
  }

  if (diff.length > MAX_DIFF_BYTES) {
    diff =
      diff.slice(0, MAX_DIFF_BYTES) +
      `\n... (diff truncated, showing first ${Math.round(MAX_DIFF_BYTES / 1024)} KB)`
  }
  return diff
}

/** Fake a unified new-file diff for an untracked file (first 400 lines). */
function synthesizeNewFileDiff(projectDir: string, rel: string): string {
  // A symlink whose target escapes the workspace must never be read through.
  // Show the symlink relationship instead of a synthetic text diff of the
  // (out-of-workspace) target.
  if (isSymlink(projectDir, rel)) {
    const target = safeReal(path.resolve(projectDir, rel))
    const targetText =
      target && (target === safeReal(projectDir) || target.startsWith((safeReal(projectDir) ?? '') + path.sep))
        ? target
        : 'outside workspace'
    return [
      `diff --git a/${rel} b/${rel}`,
      'new file mode 120000',
      '--- /dev/null',
      `+++ b/${rel}`,
      `+symlink → ${targetText}`
    ].join('\n')
  }

  const safe = safeReadablePath(projectDir, rel)
  if (!safe) {
    return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n+(unreadable file)\n`
  }

  let lines: string[]
  try {
    lines = readFileSync(safe, 'utf-8').split('\n')
  } catch {
    lines = []
  }
  const truncated = lines.length > MAX_NEW_FILE_LINES
  const body = lines.slice(0, MAX_NEW_FILE_LINES)
  const header = [
    `diff --git a/${rel} b/${rel}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${rel}`
  ]
  const content = body.map((l) => `+${l}`)
  if (truncated) {
    content.push(`+... (file truncated, showing first ${MAX_NEW_FILE_LINES} lines)`)
  }
  return [...header, ...content].join('\n')
}
