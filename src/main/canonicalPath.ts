import fs from 'node:fs'
import path from 'node:path'

/** One identity for existing paths, including Windows short/long spellings. */
export function canonicalExistingPath(target: string): string {
  return fs.realpathSync.native(path.resolve(target))
}
