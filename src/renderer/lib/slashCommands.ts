/**
 * Slash menu model: one flat item list (app commands + runtime prompts/skills),
 * prefix-first filtering with description fallback, and ZCode-style group
 * ordering (内置命令 → 命令 → 技能). Pure — unit-tested, no React.
 */
export interface SlashMenuItem {
  name: string
  description: string
  source: 'app' | 'prompt' | 'skill' | 'extension'
  builtin?: boolean
  /** App commands execute directly instead of inserting "/name". */
  run?: () => void
  icon?: unknown
}

export interface SlashGroup {
  label: string
  items: SlashMenuItem[]
}

/** Prefix on name ranks first; description hits rank second. Cap 10. */
export function filterSlashItems(items: SlashMenuItem[], query: string | null, cap = 10): SlashMenuItem[] {
  if (query === null) return items.slice(0, cap)
  const q = query.toLowerCase()
  const scored = items
    .map((item) => {
      const name = item.name.toLowerCase()
      const desc = item.description.toLowerCase()
      let score = -1
      if (name.startsWith(q)) score = 0
      else if (name.includes(q)) score = 1
      else if (q.length >= 2 && desc.includes(q)) score = 2
      return { item, score }
    })
    .filter((entry) => entry.score >= 0)
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, cap).map((entry) => entry.item)
}

export function groupSlashItems(
  items: SlashMenuItem[],
  labels: { app: string; command: string; skill: string }
): SlashGroup[] {
  const order: Array<SlashMenuItem['source']> = ['app', 'prompt', 'extension', 'skill']
  const groups: SlashGroup[] = []
  for (const source of order) {
    const bucket = items.filter((item) => item.source === source)
    if (bucket.length === 0) continue
    const label = source === 'app' ? labels.app : source === 'skill' ? labels.skill : labels.command
    groups.push({ label, items: bucket })
  }
  return groups
}
