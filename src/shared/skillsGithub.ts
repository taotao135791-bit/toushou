import { GithubSkillFile } from './types'
import { SKILL_LIMITS, skillExtensionOf, skillKindForExtension } from './skills'

/**
 * GitHub import — shared pure logic for the SKILL 目录.
 *
 * The renderer may only hand Main a URL; Main parses it here, re-validates
 * every field, and only then builds fixed-host API/raw requests itself.
 * The renderer never supplies hostnames or full URLs for fetching.
 */

export const GITHUB_URL_HOSTS = new Set(['github.com', 'raw.githubusercontent.com'])

const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/
const MAX_PATH_LENGTH = 1000

export interface ParsedGithubSkillUrl {
  kind: 'repo' | 'file'
  owner: string
  repo: string
  /** Branch/tag; a single URL segment (multi-slash refs are out of scope). */
  ref: string
  /** Repository-relative file path, segments joined by '/'. */
  path: string
}

function validSegment(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('..') &&
    SEGMENT_RE.test(value)
  )
}

function validPathSegments(path: string): boolean {
  if (!path || path.length > MAX_PATH_LENGTH) return false
  const segments = path.split('/')
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) return false
  return skillExtensionOf(segments[segments.length - 1]) !== null
}

/**
 * Accepts:
 * - https://github.com/{owner}/{repo}
 * - https://github.com/{owner}/{repo}/blob/{ref}/{path...}   (path ends .md/.html)
 * - https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}
 * Anything else (http, other hosts, traversal, missing extension) is null.
 */
export function parseGithubSkillUrl(input: unknown): ParsedGithubSkillUrl | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !GITHUB_URL_HOSTS.has(url.hostname)) return null
  if (url.username || url.password || url.search) return null

  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  const [owner, repo, third, ref, ...rest] = segments
  if (!validSegment(owner) || !validSegment(repo)) return null

  // Bare repo URL.
  if (!third) return { kind: 'repo', owner, repo, ref: '', path: '' }

  const isBlob = url.hostname === 'github.com' && third === 'blob'
  const isRaw = url.hostname === 'raw.githubusercontent.com' && third !== 'blob'
  if (!isBlob && !isRaw) return null

  if (isRaw) {
    // raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}: with a
    // single-segment ref contract, ref is segment 3 and path is the rest.
    const rawRef = third
    const path = segments.slice(3).join('/')
    if (!validSegment(rawRef) || !validPathSegments(path)) return null
    return { kind: 'file', owner, repo, ref: rawRef, path }
  }

  if (!validSegment(ref)) return null
  const path = rest.join('/')
  if (!validPathSegments(path)) return null
  return { kind: 'file', owner, repo, ref, path }
}

export interface GithubSkillCandidate {
  path: string
  sizeBytes: number
}

const SKIPPED_ROOT_FILES = new Set([
  'readme.md',
  'changelog.md',
  'license.md',
  'contributing.md',
  'security.md',
  'code_of_conduct.md'
])
const SKIPPED_PREFIXES = ['node_modules/', '.github/', 'dist/', 'build/']
export const GITHUB_IMPORT_MAX_FILES = 50

/** Auto-recognition: which repo blobs are importable skills. */
export function selectGithubSkillFiles(entries: GithubSkillCandidate[]): GithubSkillFile[] {
  const files: GithubSkillFile[] = []
  for (const entry of entries) {
    if (files.length >= GITHUB_IMPORT_MAX_FILES) break
    const path = entry.path
    if (!validPathSegments(path)) continue
    if (SKIPPED_PREFIXES.some((p) => path.toLowerCase().startsWith(p))) continue
    const lower = path.toLowerCase()
    if (lower.includes('/')) {
      // skip nested readme/changelog noise too
      const base = lower.slice(lower.lastIndexOf('/') + 1)
      if (SKIPPED_ROOT_FILES.has(base) && lower.endsWith('.md')) continue
    } else if (SKIPPED_ROOT_FILES.has(lower)) {
      continue
    }
    if (entry.sizeBytes > SKILL_LIMITS.maxFileBytes) continue
    const kind = skillKindForExtension(path.slice(path.lastIndexOf('.') + 1))
    if (!kind) continue
    files.push({ path, kind, sizeBytes: entry.sizeBytes })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
