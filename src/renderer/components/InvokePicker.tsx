import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, FileText, Plug, Sparkles, Wrench } from 'lucide-react'
import { BundledSkillEntry, LaunchableTool, SkillEntry, SlashCommand } from '@shared/types'
import { formatSkillChatMessage } from '@shared/skills'
import MenuPortal from './MenuPortal'
import { useT } from '../i18n'
import { useAppStore } from '../store'

/**
 * 技能 / 插件调用面板 — the composer "+" menu's explicit-invocation picker
 * (学 dsh：加号直接打开命令选择). Lists every capability the user can name
 * inside a prompt: package tool commands, live-session slash commands and
 * skills, the SKILL library, and MCP plugin connections. Picking one hands
 * the insertion text back to the composer, which drops it at the caret.
 */

/** One selectable row. `insert` is the exact text the composer inserts. */
export interface InvokeItem {
  id: string
  label: string
  description?: string
  group: 'tool' | 'command' | 'skill' | 'plugin'
  insert: string
}

/** What one picker pick means: text to insert at the caret. */
export type InvokePick = (insert: string) => void

interface InvokeLists {
  tools: LaunchableTool[]
  personalSkills: SkillEntry[]
  bundledSkills: BundledSkillEntry[]
  mcpServers: string[]
}

const EMPTY_LISTS: InvokeLists = { tools: [], personalSkills: [], bundledSkills: [], mcpServers: [] }
/** Cached window for the session-independent catalogs (same TTL idea as files). */
const LIST_TTL_MS = 30_000
let cache: { lists: InvokeLists; at: number } | null = null

async function loadInvokeLists(): Promise<InvokeLists> {
  if (cache && Date.now() - cache.at < LIST_TTL_MS) return cache.lists
  const api = window.electronAPI
  const [tools, skills, bundled, connections] = await Promise.all([
    api.listLaunchableTools?.().catch(() => []) ?? [],
    api.listSkills?.().then((result) => (result.ok ? result.entries : [])).catch(() => []) ?? [],
    api.listBundledSkills?.().then((result) => (result.ok ? result.entries : [])).catch(() => []) ?? [],
    api.mcpList?.().then((all) => all.filter(({ enabled }) => enabled).map(({ name: server }) => server)).catch(() => []) ?? []
  ])
  const lists: InvokeLists = { tools, personalSkills: skills, bundledSkills: bundled, mcpServers: connections }
  cache = { lists, at: Date.now() }
  return lists
}

export function invalidateInvokeLists(): void {
  cache = null
}

export default function InvokePicker({
  open,
  triggerRef,
  onClose,
  onPick,
  commands
}: {
  open: boolean
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onPick: InvokePick
  /** Live-session slash commands (empty for the not-yet-created chat). */
  commands?: SlashCommand[]
}) {
  const t = useT()
  const language = useAppStore((s) => s.language)
  const [lists, setLists] = useState<InvokeLists>(EMPTY_LISTS)
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    let cancelled = false
    void loadInvokeLists().then((next) => {
      if (!cancelled) {
        setLists(next)
        setLoaded(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const items = useMemo<InvokeItem[]>(() => {
    const rows: InvokeItem[] = []
    for (const tool of lists.tools) {
      if (!tool.command) continue
      rows.push({ id: tool.id, label: tool.label, description: tool.description, group: 'tool', insert: `${tool.command} ` })
    }
    for (const command of commands ?? []) {
      // Launchable tools already cover package prompts; dedupe by command name.
      if (rows.some((row) => row.insert === `/${command.name} `)) continue
      rows.push({
        id: `cmd:${command.name}`,
        label: `/${command.name}`,
        description: command.description,
        group: command.source === 'skill' ? 'skill' : 'command',
        insert: `/${command.name} `
      })
    }
    for (const skill of lists.personalSkills) {
      if (skill.kind !== 'markdown') continue
      rows.push({ id: `skill:${skill.id}`, label: skill.name, description: skill.description, group: 'skill', insert: `skill:${skill.id}` })
    }
    for (const skill of lists.bundledSkills) {
      rows.push({ id: `bundled:${skill.id}`, label: skill.name, description: skill.description, group: 'skill', insert: `bundled:${skill.id}` })
    }
    for (const name of lists.mcpServers) {
      rows.push({ id: `mcp:${name}`, label: name, group: 'plugin', insert: `@mcp:${name} ` })
    }
    return rows
  }, [lists, commands])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter(
      (item) => item.label.toLowerCase().includes(needle) || item.description?.toLowerCase().includes(needle)
    )
  }, [items, query])

  const groups = useMemo(() => {
    const order: InvokeItem['group'][] = ['tool', 'command', 'skill', 'plugin']
    return order
      .map((group) => ({ group, rows: filtered.filter((item) => item.group === group) }))
      .filter((entry) => entry.rows.length > 0)
  }, [filtered])

  /**
   * Personal and bundled skills expand into their full invocation text (SOP
   * block / designed prompt) at pick time — the body can be large and the
   * catalogs are already cached, so resolving on demand keeps the row list
   * cheap. Slash tokens and MCP mentions insert verbatim.
   */
  const pick = async (item: InvokeItem) => {
    if (item.insert.startsWith('skill:')) {
      const entry = lists.personalSkills.find((skill) => `skill:${skill.id}` === item.insert)
      if (!entry) return
      const result = await window.electronAPI.readSkill?.(entry.id).catch(() => null)
      if (!result?.ok) return
      onPick(`\n${formatSkillChatMessage(entry.name, result.content, language)}\n`)
    } else if (item.insert.startsWith('bundled:')) {
      const entry = lists.bundledSkills.find((skill) => `bundled:${skill.id}` === item.insert)
      if (!entry) return
      onPick(`\n${entry.prompt.trim()}\n`)
    } else {
      onPick(item.insert)
    }
    onClose()
  }

  const groupTitle = (group: InvokeItem['group']): string =>
    ({ tool: t('composer.invoke.groupTool'), command: t('composer.invoke.groupCommand'), skill: t('composer.invoke.groupSkill'), plugin: t('composer.invoke.groupPlugin') })[group]

  const GroupIcon = (group: InvokeItem['group']) =>
    group === 'tool' ? <Wrench size={12} className="shrink-0 text-cream-faint" />
      : group === 'command' ? <Command size={12} className="shrink-0 text-cream-faint" />
        : group === 'skill' ? <Sparkles size={12} className="shrink-0 text-accent" />
          : <Plug size={12} className="shrink-0 text-cream-faint" />

  return (
    <MenuPortal open={open} triggerRef={triggerRef} onClose={onClose} width={320} maxHeight={480}>
      <div className="sticky top-0 z-10 bg-ink-850 p-1.5">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('composer.invoke.filter')}
          aria-label={t('composer.invoke.filter')}
          className="w-full rounded-lg border border-line bg-ink-900 px-2.5 py-1.5 text-[12.5px] text-cream placeholder-cream-faint outline-none focus:border-accent/40"
        />
      </div>
      {!loaded && (
        <p className="px-2.5 py-2 text-[12px] text-cream-faint">{t('composer.invoke.loading')}</p>
      )}
      {loaded && groups.length === 0 && (
        <p className="px-2.5 py-2 text-[12px] text-cream-faint">{t('composer.invoke.empty')}</p>
      )}
      {groups.map(({ group, rows }) => (
        <div key={group} className="mb-1">
          <p className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-cream-faint">
            {groupTitle(group)}
          </p>
          {rows.map((item) => (
            <button
              key={item.id}
              onClick={() => void pick(item)}
              className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-overlay"
            >
              {GroupIcon(group)}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-cream">{item.label}</span>
                {item.description && (
                  <span className="block truncate text-[11px] text-cream-faint">{item.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      ))}
      <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10.5px] text-cream-faint">
        <FileText size={10} className="shrink-0" />
        {t('composer.invoke.hint')}
      </p>
    </MenuPortal>
  )
}
