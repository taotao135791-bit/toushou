import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'

/**
 * Flat relative-path file list of a project, backing the composer's @ menu.
 * Prefers `git ls-files` (tracked + untracked, honors .gitignore); falls back
 * to a capped recursive walk outside git repos. Results are cached briefly
 * so typing in the menu doesn't rescan the tree on every keystroke.
 */

const execFileAsync = promisify(execFile)

const MAX_FILES = 5000
const CACHE_TTL_MS = 30_000

/** Directories never worth offering in the @ menu. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'release',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.turbo'
])

interface CacheEntry {
  files: string[]
  at: number
}

const cache = new Map<string, CacheEntry>()

/** Relative file paths of the project (sorted, capped at 5000), 30s cached. */
export async function listProjectFiles(projectDir: string): Promise<string[]> {
  const cached = cache.get(projectDir)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.files
  const files = ((await gitFiles(projectDir)) ?? (await walkFiles(projectDir)))
    .sort()
    .slice(0, MAX_FILES)
  cache.set(projectDir, { files, at: Date.now() })
  return files
}

/** Tracked + untracked files; null when not a git repo or git is missing. */
async function gitFiles(projectDir: string): Promise<string[] | null> {
  try {
    const { stdout } = (await execFileAsync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: projectDir,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024
    })) as { stdout: string; stderr: string }
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}

/** Non-git fallback: recursive walk, skipping hidden + dependency dirs. */
async function walkFiles(projectDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        out.push(path.relative(projectDir, abs))
      }
    }
  }
  await walk(projectDir)
  return out
}
