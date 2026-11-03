import { app } from 'electron'
import { homedir } from 'node:os'
import path from 'node:path'

type SystemPathName = 'home' | 'documents' | 'desktop' | 'downloads' | 'userData'
export interface WorkspaceSystemPaths {
  documents: string
  downloads: string
  defaultWorkspace: string
  protectedPaths: string[]
  /** Unknown redirected system folders must never be silently unprotected. */
  deletionProtectionComplete: boolean
}

/** Reject roots, including Windows extended-length UNC shares. */
function safeSystemDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value)) return null
  const normalized = path.normalize(value)
  let rootComparable = normalized
  if (process.platform === 'win32') {
    rootComparable = rootComparable.replace(/^\\\\\?\\UNC\\/i, '\\\\')
    rootComparable = rootComparable.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '')
    rootComparable = path.normalize(rootComparable)
  }
  const root = path.parse(rootComparable).root
  if (!root || path.relative(root, rootComparable) === '') return null
  return normalized
}

/** Main-only paths: Electron knows redirected folders; conventional paths are additional protection. */
export function resolveWorkspaceSystemPaths(getPath: (name: SystemPathName) => string, fallbackHome: () => string = homedir): WorkspaceSystemPaths {
  const read = (name: SystemPathName): string | null => {
    try { return safeSystemDirectory(getPath(name)) }
    catch { return null }
  }
  const nativeHome = read('home')
  const userData = read('userData')
  let osHome: string | null = null
  try { osHome = safeSystemDirectory(fallbackHome()) } catch { /* system home unavailable */ }
  const trustedHome = nativeHome ?? osHome
  const nativeDocuments = read('documents')
  const nativeDesktop = read('desktop')
  const nativeDownloads = read('downloads')
  // Never invent a workspace from cwd, a filesystem root or temporary storage.
  // If neither native Documents nor a trusted home is known, an empty path
  // leaves workspace-dependent operations unavailable while startup continues.
  const documents = nativeDocuments ?? (trustedHome ? path.join(trustedHome, 'Documents') : '')
  const downloads = nativeDownloads ?? (trustedHome ? path.join(trustedHome, 'Downloads') : '')
  const homes = [...new Set([nativeHome, osHome].filter((value): value is string => !!value))]
  const protectedPaths = [...new Set([
    ...homes, ...(userData ? [userData] : []),
    ...homes.flatMap(home => [path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Downloads')]),
    ...(nativeDocuments ? [nativeDocuments] : []), ...(nativeDesktop ? [nativeDesktop] : []), ...(nativeDownloads ? [nativeDownloads] : [])
  ])]
  return { documents, downloads, defaultWorkspace: documents ? path.join(documents, '投手工作区') : '', protectedPaths,
    deletionProtectionComplete: Boolean(trustedHome && userData && nativeDocuments && nativeDesktop && nativeDownloads) }
}

/** Resolve a delete request only after all protected OS locations are known. */
export function projectSystemPathsError(paths: WorkspaceSystemPaths): 'system-paths-unavailable' | null {
  return paths.deletionProtectionComplete ? null : 'system-paths-unavailable'
}

let cached: WorkspaceSystemPaths | undefined
/** Cache once per process so IPC, project registry and Feishu use exactly the same workspace. */
export function getWorkspaceSystemPaths(): WorkspaceSystemPaths {
  return cached ??= resolveWorkspaceSystemPaths(name => app.getPath(name))
}
export function resetWorkspaceSystemPathsForTest(): void { cached = undefined }
