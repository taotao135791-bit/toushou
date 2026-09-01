import {
  GithubSkillImportRequest,
  GithubSkillSource,
  SkillEntry,
  SkillGithubImportResult,
  SkillGithubPreviewResult
} from '../shared/types'
import {
  GITHUB_IMPORT_MAX_FILES,
  GithubSkillCandidate,
  parseGithubSkillUrl,
  selectGithubSkillFiles
} from '../shared/skillsGithub'
import { SKILL_LIMITS } from '../shared/skills'
import { skillsDir, storeSkillContent } from './skills'

/**
 * GitHub import for the SKILL 目录. All network access lives here in Main:
 * the renderer passes a URL, shared/skillsGithub.ts parses and validates it,
 * and this module talks only to api.github.com / raw.githubusercontent.com
 * over https with bounded timeouts and the same per-file caps as local
 * imports. Public repos only — no credentials are used or stored.
 */

const API_BASE = 'https://api.github.com'
const RAW_BASE = 'https://raw.githubusercontent.com'
const FETCH_TIMEOUT_MS = 15_000
const MAX_IMPORT_BYTES = SKILL_LIMITS.maxFileBytes

async function githubFetch(url: string, accept: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': 'toushou-skill-import', Accept: accept },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
}

function apiError(status: number): 'repo-not-found' | 'rate-limited' | 'network-failed' {
  if (status === 404) return 'repo-not-found'
  if (status === 403 || status === 429) return 'rate-limited'
  return 'network-failed'
}

function encodeRawPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function repoUrl(owner: string, repo: string): string {
  return API_BASE + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo)
}

export async function previewGithubSkills(rawUrl: unknown): Promise<SkillGithubPreviewResult> {
  const parsed = parseGithubSkillUrl(rawUrl)
  if (!parsed) return { ok: false, error: 'invalid-url' }

  if (parsed.kind === 'file') {
    return {
      ok: true,
      source: { kind: 'file', owner: parsed.owner, repo: parsed.repo, ref: parsed.ref },
      files: [
        {
          path: parsed.path,
          kind: parsed.path.toLowerCase().endsWith('.html') ? 'html' : 'markdown',
          sizeBytes: 0
        }
      ]
    }
  }

  let repoResponse: Response
  try {
    repoResponse = await githubFetch(repoUrl(parsed.owner, parsed.repo), 'application/vnd.github+json')
  } catch {
    return { ok: false, error: 'network-failed' }
  }
  if (!repoResponse.ok) return { ok: false, error: apiError(repoResponse.status) }
  let repoJson: { default_branch?: unknown }
  try {
    repoJson = await repoResponse.json()
  } catch {
    return { ok: false, error: 'network-failed' }
  }
  const branch = typeof repoJson.default_branch === 'string' ? repoJson.default_branch : ''
  if (!branch || branch.includes('/') || branch.length > 200) {
    return { ok: false, error: 'repo-not-found' }
  }

  let treeResponse: Response
  try {
    treeResponse = await githubFetch(
      repoUrl(parsed.owner, parsed.repo) +
        '/git/trees/' +
        encodeURIComponent(branch) +
        '?recursive=1',
      'application/vnd.github+json'
    )
  } catch {
    return { ok: false, error: 'network-failed' }
  }
  if (!treeResponse.ok) return { ok: false, error: apiError(treeResponse.status) }
  let treeJson: { tree?: unknown }
  try {
    treeJson = await treeResponse.json()
  } catch {
    return { ok: false, error: 'network-failed' }
  }
  const candidates: GithubSkillCandidate[] = []
  if (Array.isArray(treeJson.tree)) {
    for (const node of treeJson.tree) {
      if (!node || typeof node !== 'object') continue
      const entry = node as Record<string, unknown>
      if (entry.type !== 'blob') continue
      if (typeof entry.path !== 'string' || typeof entry.size !== 'number') continue
      candidates.push({ path: entry.path, sizeBytes: entry.size })
    }
  }
  const files = selectGithubSkillFiles(candidates)
  if (files.length === 0) return { ok: false, error: 'no-files' }
  const source: GithubSkillSource = {
    kind: 'repo',
    owner: parsed.owner,
    repo: parsed.repo,
    ref: branch
  }
  return { ok: true, source, files }
}

function validImportSource(source: unknown): source is GithubSkillSource {
  if (!source || typeof source !== 'object') return false
  const s = source as Record<string, unknown>
  // Encode each field: an unencoded '../' would be laundered into a harmless
  // path by URL normalization and slip past the parser.
  const again = parseGithubSkillUrl(
    'https://github.com/' + encodeURIComponent(String(s.owner ?? '')) + '/' + encodeURIComponent(String(s.repo ?? ''))
  )
  return (
    (s.kind === 'repo' || s.kind === 'file') &&
    again !== null &&
    typeof s.ref === 'string' &&
    s.ref.length > 0 &&
    !s.ref.includes('/') &&
    s.ref.length <= 200
  )
}

export async function importGithubSkills(
  request: unknown,
  dir: string = skillsDir()
): Promise<SkillGithubImportResult> {
  if (!request || typeof request !== 'object') return { ok: false, error: 'invalid-request' }
  const req = request as Partial<GithubSkillImportRequest>
  if (!validImportSource(req.source) || !Array.isArray(req.paths)) {
    return { ok: false, error: 'invalid-request' }
  }
  const source = req.source
  const paths = (req.paths as unknown[])
    .filter((p): p is string => typeof p === 'string')
    .slice(0, GITHUB_IMPORT_MAX_FILES)
  if (paths.length === 0) return { ok: false, error: 'invalid-request' }

  const imported: SkillEntry[] = []
  const skipped: { path: string; reason: 'too-large' | 'fetch-failed' | 'invalid-file' }[] = []
  for (const filePath of paths) {
    const parsed = parseGithubSkillUrl(
      'https://github.com/' +
        encodeURIComponent(source.owner) +
        '/' +
        encodeURIComponent(source.repo) +
        '/blob/' +
        encodeURIComponent(source.ref) +
        '/' +
        encodeRawPath(filePath)
    )
    if (!parsed || parsed.kind !== 'file' || parsed.path !== filePath) {
      skipped.push({ path: filePath, reason: 'invalid-file' })
      continue
    }
    let response: Response
    try {
      response = await githubFetch(
        RAW_BASE +
          '/' +
          encodeURIComponent(source.owner) +
          '/' +
          encodeURIComponent(source.repo) +
          '/' +
          encodeURIComponent(source.ref) +
          '/' +
          encodeRawPath(filePath),
        'text/plain'
      )
    } catch {
      skipped.push({ path: filePath, reason: 'fetch-failed' })
      continue
    }
    if (!response.ok) {
      skipped.push({ path: filePath, reason: 'fetch-failed' })
      continue
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (contentLength > MAX_IMPORT_BYTES) {
      skipped.push({ path: filePath, reason: 'too-large' })
      continue
    }
    let content: string
    try {
      content = await response.text()
    } catch {
      skipped.push({ path: filePath, reason: 'fetch-failed' })
      continue
    }
    if (content.length > MAX_IMPORT_BYTES) {
      skipped.push({ path: filePath, reason: 'too-large' })
      continue
    }
    const entry = storeSkillContent(
      filePath.slice(filePath.lastIndexOf('/') + 1),
      content,
      dir
    )
    if (entry) {
      imported.push(entry)
    } else {
      skipped.push({ path: filePath, reason: 'invalid-file' })
    }
  }
  return { ok: true, imported, skipped }
}
