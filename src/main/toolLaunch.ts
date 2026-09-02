import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { LaunchableTool } from '../shared/types'
import { listPackages } from './packages'

/**
 * One-click tool discovery. A "tool" is any native package that ships at
 * least one prompt template: prompts/<name>.md becomes the /<name> slash
 * command, so launching it is just "new session + send that command".
 *
 * Sources:
 * - bundled: package-shaped subdirectories of the app's resources root
 *   (e.g. ads-toolkit), discovered by manifest so this list grows with
 *   whatever ships in the bundle, not a hardcoded registry;
 * - installed: packages the runtime lists that expose a local install path.
 */

export interface ToolPackageManifest {
  name: string
  label: string
  description?: string
}

/** Read the launch-relevant facts from a package's package.json, or null. */
export function readToolManifest(pkgRoot: string): ToolPackageManifest | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : ''
    if (!name) return null
    return {
      name,
      label:
        typeof raw.displayName === 'string' && raw.displayName.trim()
          ? raw.displayName.trim()
          : name,
      description:
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim()
          : undefined
    }
  } catch {
    return null
  }
}

/**
 * Slash commands offered by a package's prompts/ directory. File base names
 * become commands; only simple lowercase-ish names are accepted so a stray
 * file can never inject an arbitrary command string.
 */
export function scanPromptCommands(pkgRoot: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(path.join(pkgRoot, 'prompts'))
  } catch {
    return []
  }
  const commands: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const base = entry.slice(0, -3).trim()
    if (/^[a-z0-9][a-z0-9-]*$/i.test(base)) commands.push(`/${base}`)
  }
  return commands.sort()
}

export function toolsFromPackageRoot(
  pkgRoot: string,
  origin: 'bundled' | 'installed'
): LaunchableTool[] {
  const manifest = readToolManifest(pkgRoot)
  if (!manifest) return []
  return scanPromptCommands(pkgRoot).map((command) => ({
    id: `${manifest.name}:${command}`,
    packageName: manifest.name,
    label: manifest.label,
    command,
    description: manifest.description,
    origin
  }))
}

function bundledResourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

/**
 * Every launchable tool from bundled and installed packages. Deduped by
 * command with installed entries winning over the bundled copy — a package
 * installed from its update-source repo must not surface a twin.
 */
export async function listLaunchableTools(): Promise<LaunchableTool[]> {
  const byCommand = new Map<string, LaunchableTool>()
  const bundledPackageNames = new Set<string>()

  try {
    for (const entry of readdirSync(bundledResourceRoot())) {
      const root = path.join(bundledResourceRoot(), entry)
      try {
        if (!statSync(root).isDirectory()) continue
      } catch {
        continue
      }
      for (const tool of toolsFromPackageRoot(root, 'bundled')) {
        bundledPackageNames.add(tool.packageName)
        byCommand.set(tool.command, tool)
      }
    }
  } catch {
    // Resources root unreadable — fall through to installed packages.
  }

  for (const pkg of await listPackages().catch(() => [])) {
    if (!pkg.path) continue
    for (const tool of toolsFromPackageRoot(pkg.path, 'installed')) {
      // The bundled package is linked into the runtime on first launch. Keep
      // that package visibly classified as built-in even though the runtime
      // path wins for execution and updates.
      byCommand.set(
        tool.command,
        bundledPackageNames.has(tool.packageName) ? { ...tool, origin: 'bundled' } : tool
      )
    }
  }

  return [...byCommand.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.command.localeCompare(b.command)
  )
}
