import path from 'node:path'
import { canonicalExistingPath } from './canonicalPath'

const deleting = new Set<string>()
export function pathsOverlap(a: string, b: string): boolean {
  const within = (root: string, target: string): boolean => {
    const rel = path.relative(root, target)
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
  }
  return within(a, b) || within(b, a)
}
export function isProjectDeletionInProgress(cwd: string): boolean {
  let resolved: string
  try { resolved = canonicalExistingPath(cwd) } catch { resolved = path.resolve(cwd) }
  return [...deleting].some(root => pathsOverlap(root, resolved))
}
export function beginProjectDeletion(root: string): boolean {
  if (isProjectDeletionInProgress(root)) return false
  deleting.add(root)
  return true
}
export function endProjectDeletion(root: string): void { deleting.delete(root) }
