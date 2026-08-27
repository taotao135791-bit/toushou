/**
 * Community pi packages.
 *
 * The curated marketplace list is static data: the featured packages live on
 * GitHub and have no npm registry entry to fetch, and a static list keeps the
 * marketplace usable offline. Live npm registry search (keyword `pi-package`)
 * still doubles as the ecosystem index (pi.dev/packages points there too).
 */
import { CommunityPackageInfo, CuratedPackageInfo } from '../shared/types'

export type CommunityPackage = CommunityPackageInfo

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search'
const TIMEOUT_MS = 10_000

/**
 * GitHub-hosted picks featured at the top of the marketplace. Every entry was
 * verified to exist and to carry a `pi` manifest plus the `pi-package`
 * keyword. `name` is the npm name where one is known, otherwise the repo name.
 */
export const CURATED_GIT_PACKAGES: CuratedPackageInfo[] = [
  {
    name: 'pi-web-access',
    repo: 'nicobailon/pi-web-access',
    description: 'Web search, URL fetching, GitHub cloning, PDF/YouTube extraction',
    category: 'web'
  },
  {
    name: 'pi-mcp-adapter',
    repo: 'nicobailon/pi-mcp-adapter',
    description: 'Token-efficient MCP (Model Context Protocol) adapter',
    category: 'mcp'
  },
  {
    name: 'pi-subagents',
    repo: 'nicobailon/pi-subagents',
    description: 'Async subagent delegation with truncation & artifacts',
    category: 'agents'
  },
  {
    name: 'pi-subagents',
    repo: 'tintinweb/pi-subagents',
    description: 'Claude Code-style subagents: parallel runs, live widget, mid-run steering',
    category: 'agents'
  },
  {
    name: 'pi-lens',
    repo: 'apmantza/pi-lens',
    description: 'Real-time code feedback: LSP, linters, formatters, type-checking',
    category: 'quality'
  },
  {
    name: 'context-mode',
    repo: 'mksglu/context-mode',
    description: 'Context-window saver: sandboxed execution + FTS5 knowledge base',
    category: 'productivity'
  },
  {
    name: 'pi-permission-system',
    repo: 'gotgenes/pi-permission-system',
    description: 'Permission enforcement extension',
    category: 'safety'
  },
  {
    name: 'cc-safety-net',
    repo: 'kenryu42/cc-safety-net',
    description: 'Blocks destructive git/fs commands and secret-file access',
    category: 'safety'
  },
  {
    name: 'rpiv-todo',
    repo: 'juicesharp/rpiv-todo',
    description: 'Model todo list rendered as a live overlay',
    category: 'productivity'
  },
  {
    name: 'rpiv-ask-user-question',
    repo: 'juicesharp/rpiv-ask-user-question',
    description: 'Structured typed questionnaires from the model',
    category: 'productivity'
  },
  {
    name: 'pi-background-tasks',
    repo: 'ismailsaleekh/pi-background-tasks',
    description: 'Durable background shell tasks via child pi processes',
    category: 'productivity'
  }
]

export async function searchCommunityPackages(
  query: string,
  curatedOnly = false
): Promise<CommunityPackage[]> {
  if (curatedOnly) {
    return CURATED_GIT_PACKAGES.map((p) => ({
      name: p.name,
      description: p.description,
      version: '',
      repo: p.repo,
      category: p.category
    }))
  }
  const text = `keywords:pi-package ${query.trim()}`.trim()
  const url = `${SEARCH_URL}?text=${encodeURIComponent(text)}&size=20`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
    clearTimeout(timer)
    if (!res.ok) return []
    const data = (await res.json()) as {
      objects?: { package?: { name?: string; description?: string; version?: string } }[]
    }
    const out: CommunityPackage[] = []
    for (const o of data.objects ?? []) {
      const p = o.package
      if (!p?.name) continue
      out.push({
        name: p.name,
        description: typeof p.description === 'string' ? p.description : '',
        version: typeof p.version === 'string' ? p.version : ''
      })
    }
    return out
  } catch {
    return []
  }
}
