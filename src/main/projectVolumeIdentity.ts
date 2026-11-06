import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import path from 'node:path'

type Execute = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string
interface VolumeIdentityOptions {
  platform?: NodeJS.Platform
  exec?: Execute
  now?: () => number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_CACHE_ENTRIES = 128

/** Resolve the persistent volume identity; st_dev alone is only a mount identity. */
export function createProjectVolumeIdResolver(options: VolumeIdentityOptions = {}) {
  const platform = options.platform ?? process.platform
  const execute: Execute = options.exec ?? ((file, args, commandOptions) => execFileSync(file, args, commandOptions))
  const now = options.now ?? Date.now
  const cache = new Map<number, { id: string | null; expiresAt: number }>()
  const remember = (dev: number, id: string | null): string | null => {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
    cache.set(dev, { id, expiresAt: id ? Infinity : now() + 2000 })
    return id
  }
  return (canonicalPath: string, dev: number, force = false): string | null => {
    if (platform !== 'darwin' || !path.posix.isAbsolute(canonicalPath) || /[\x00\r\n]/.test(canonicalPath) || !Number.isSafeInteger(dev) || dev < 0) return null
    const cached = cache.get(dev)
    if (!force && cached && cached.expiresAt > now()) return cached.id
    // A failed forced check must not leave an older identity available to callers.
    cache.delete(dev)
    try {
      const commandOptions: ExecFileSyncOptionsWithStringEncoding = {
        encoding: 'utf8', timeout: 1500, maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' }
      }
      const lines = execute('/bin/df', ['-P', canonicalPath], commandOptions).trim().split(/\r?\n/)
      // POSIX format must describe exactly one local disk. Never pass an
      // untrusted filesystem label, network share, or additional row to diskutil.
      if (lines.length !== 2) return remember(dev, null)
      const row = lines[1].match(/^\s*(\/dev\/disk[0-9]+(?:s[0-9]+)*)[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+[0-9]+%[ \t]+[^\r\n]+$/)
      if (!row) return remember(dev, null)
      const plist = execute('/usr/sbin/diskutil', ['info', '-plist', row[1]], commandOptions)
      if (/<key>\s*Error\s*<\/key>\s*<true\s*\/>/.test(plist)) return remember(dev, null)
      const matches = [...plist.matchAll(/<key>\s*VolumeUUID\s*<\/key>\s*<string>([^<]*)<\/string>/g)]
      if (matches.length !== 1 || !UUID.test(matches[0][1])) return remember(dev, null)
      const id = matches[0][1].toLowerCase()
      return remember(dev, id)
    } catch {
      // Missing utilities, unsupported filesystems, timeouts and oversized
      // output retain the registry's stricter fallback identity checks.
      return remember(dev, null)
    }
  }
}

export const getProjectVolumeId = createProjectVolumeIdResolver()
