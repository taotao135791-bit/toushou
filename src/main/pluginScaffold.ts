/**
 * Filesystem half of the plugin scaffold. All content and validation lives in
 * src/shared/pluginScaffold.ts; this module only resolves paths and writes.
 * Its parentDir is Main-internal, resolved from an opaque DirectoryGrant by
 * the IPC layer — never a renderer-supplied path.
 */
import crypto from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { PluginScaffoldError, PluginScaffoldInternalResult, PluginScaffoldSpec } from '../shared/types'
import { planPluginFiles, validatePluginSpec } from '../shared/pluginScaffold'

type DestinationState = 'missing' | 'empty' | 'non-empty' | 'unsafe'

/**
 * Create <spec.parentDir>/<spec.name>/ with the planned files.
 *
 * Every generated file is first written into a private sibling staging
 * directory and the complete tree is renamed into place only at the end. A
 * failed write therefore cannot leave a partial package directory that makes
 * the selected DirectoryGrant impossible to retry. Existing non-empty target
 * directories are never overwritten.
 */
export function scaffoldPlugin(spec: PluginScaffoldSpec): PluginScaffoldInternalResult {
  const invalid = validatePluginSpec(spec)
  if (invalid) return { ok: false, error: invalid }

  const parentPath = path.resolve(spec.parentDir)
  let parentReal: string
  try {
    if (!statSync(parentPath).isDirectory()) return { ok: false, error: 'dir-missing' }
    // IPC resolves a DirectoryGrant to a real path, but keep this standalone
    // filesystem function safe for direct callers and future internal reuse.
    if (lstatSync(parentPath).isSymbolicLink()) return { ok: false, error: 'unsafe-path' }
    parentReal = realpathSync(parentPath)
  } catch {
    return { ok: false, error: 'dir-missing' }
  }

  const packageSegments = spec.name.split('/')
  const packageName = packageSegments[packageSegments.length - 1] ?? ''
  if (!packageName || packageSegments.some((segment) => !isSafePathSegment(segment))) {
    return { ok: false, error: 'unsafe-path' }
  }

  const planned = planPluginFiles(spec)
  if (!planned.every((file) => isSafePlannedFile(file.relativePath))) {
    return { ok: false, error: 'unsafe-path' }
  }

  // For a scoped package, safely create/traverse the `@scope` parent before
  // looking at the package directory itself. Do not create the final target
  // yet: it must stay absent until the staged tree can be published.
  const packageParent = ensureSafeDirectory(parentReal, packageSegments.slice(0, -1))
  if (!packageParent) return { ok: false, error: 'unsafe-path' }
  const destination = path.join(packageParent, packageName)
  if (!isInside(parentReal, destination)) return { ok: false, error: 'unsafe-path' }

  const initialState = inspectDestination(parentReal, destination)
  if (initialState === 'unsafe') return { ok: false, error: 'unsafe-path' }
  if (initialState === 'non-empty') return { ok: false, error: 'dir-not-empty' }

  let stagingDir: string | null = null
  try {
    stagingDir = createSafeStagingDirectory(parentReal, packageParent)
    if (!stagingDir) return { ok: false, error: 'write-failed' }

    for (const file of planned) {
      const parts = file.relativePath.split('/')
      const fileName = parts.pop()
      if (!fileName || parts.some((part) => !isSafePathSegment(part))) {
        return { ok: false, error: 'unsafe-path' }
      }
      const targetDir = ensureSafeDirectory(stagingDir, parts)
      if (!targetDir) return { ok: false, error: 'unsafe-path' }
      writeNewFileInside(stagingDir, targetDir, fileName, file.content)
    }

    const publishError = publishStagingDirectory(parentReal, stagingDir, destination)
    if (publishError) return { ok: false, error: publishError }
    stagingDir = null // rename succeeded; cleanup must never delete the output.
  } catch (err) {
    return {
      ok: false,
      error: 'write-failed',
      detail: err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (stagingDir) removeSafeStagingDirectory(parentReal, stagingDir)
  }

  // Preserve the old lexical internal result for direct Main callers/tests.
  // It never crosses preload: IPC converts it to PluginScaffoldOutput first.
  return { ok: true, dir: path.join(parentPath, ...packageSegments), files: planned.map((f) => f.relativePath) }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function isSafePathSegment(segment: string): boolean {
  return (
    Boolean(segment) &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0')
  )
}

function isSafePlannedFile(relativePath: string): boolean {
  const parts = relativePath.split('/')
  const fileName = parts.pop()
  if (!fileName) return false
  return isSafePathSegment(fileName) && parts.every(isSafePathSegment)
}

/**
 * Create/traverse one directory component at a time, refusing symlinks and
 * rechecking canonical containment after every step. `mkdir({ recursive })`
 * would follow a pre-existing symlink, which is precisely what this avoids.
 */
function ensureSafeDirectory(root: string, segments: string[]): string | null {
  let current = root
  for (const segment of segments) {
    if (!isSafePathSegment(segment)) return null
    const candidate = path.join(current, segment)
    if (!isInside(root, candidate)) return null
    try {
      const stat = lstatSync(candidate)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    } catch {
      try {
        mkdirSync(candidate)
        const stat = lstatSync(candidate)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null
      } catch {
        return null
      }
    }
    try {
      const real = realpathSync(candidate)
      if (!isInside(root, real)) return null
      current = real
    } catch {
      return null
    }
  }
  return current
}

function inspectDestination(root: string, destination: string): DestinationState {
  try {
    const stat = lstatSync(destination)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe'
    const real = realpathSync(destination)
    if (!isInside(root, real)) return 'unsafe'
    return readdirSync(real).length === 0 ? 'empty' : 'non-empty'
  } catch (err) {
    return isMissingPath(err) ? 'missing' : 'unsafe'
  }
}

/** Create a fresh, hidden staging sibling below an already-safe parent. */
function createSafeStagingDirectory(root: string, parent: string): string | null {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(parent, `.omp-scaffold-${crypto.randomUUID()}`)
    if (!isInside(root, candidate)) return null
    try {
      mkdirSync(candidate, { mode: 0o700 })
    } catch (err) {
      if (isAlreadyExists(err)) continue
      return null
    }
    try {
      const stat = lstatSync(candidate)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
      const real = realpathSync(candidate)
      return isInside(root, real) ? real : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Atomically swap the fully written staging directory into its final name.
 * POSIX allows replacing an empty directory with rename; on platforms that do
 * not, remove only the already-validated empty placeholder then retry. Either
 * path leaves no partial generated package at `destination` on write failure.
 */
function publishStagingDirectory(
  root: string,
  stagingDir: string,
  destination: string
): PluginScaffoldError | null {
  const stagingReal = realpathSync(stagingDir)
  if (!isInside(root, stagingReal)) return 'unsafe-path'

  const destinationState = inspectDestination(root, destination)
  if (destinationState === 'unsafe') return 'unsafe-path'
  if (destinationState === 'non-empty') return 'dir-not-empty'
  try {
    renameSync(stagingReal, destination)
    return null
  } catch {
    // Windows rejects replacing an existing empty directory. Re-check it right
    // before removal so a concurrent user write is never discarded.
    if (destinationState !== 'empty' || inspectDestination(root, destination) !== 'empty') {
      return 'write-failed'
    }
    try {
      rmdirSync(destination)
      renameSync(stagingReal, destination)
      return null
    } catch {
      return 'write-failed'
    }
  }
}

/** Cleanup only the private random staging directory created by this call. */
function removeSafeStagingDirectory(root: string, stagingDir: string): void {
  try {
    const stat = lstatSync(stagingDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    if (!isInside(root, realpathSync(stagingDir))) return
    rmSync(stagingDir, { recursive: true, force: true })
  } catch {
    // Cleanup should never replace the original write error or touch another path.
  }
}

/**
 * Write a new generated file only after re-checking its physical parent. The
 * exclusive + no-follow open prevents an existing symlink/file from being
 * overwritten between our check and the write on platforms that support it.
 */
function writeNewFileInside(root: string, parent: string, name: string, content: string): void {
  if (!isSafePathSegment(name)) throw new Error('unsafe file name')
  const parentReal = realpathSync(parent)
  if (!isInside(root, parentReal)) throw new Error('unsafe file parent')
  const target = path.join(parentReal, name)
  if (!isInside(root, target)) throw new Error('unsafe file target')
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW
  const fd = openSync(target, flags, 0o600)
  try {
    writeFileSync(fd, content, 'utf-8')
  } finally {
    closeSync(fd)
  }
}

function isMissingPath(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')
}

function isAlreadyExists(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')
}
