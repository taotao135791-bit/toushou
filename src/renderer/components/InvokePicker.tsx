import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { BookOpen, ChevronRight, Command, Layers, Link2, Wrench } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import BrandIcon from './BrandIcon'
import { BundledSkillEntry, LaunchableTool, SkillEntry, SlashCommand } from '@shared/types'
import { formatSkillChatMessage } from '@shared/skills'
import { isMcpMentionName } from '@shared/mcpMentions'
import MenuPortal from './MenuPortal'
import { useT } from '../i18n'
import { useAppStore } from '../store'
import { showNotice } from '../lib/notice'
import { ComposerInvocation } from '../lib/composerInvocation'

interface InvokeItem {
  id: string
  label: string
  description?: string
  group: 'tool' | 'command' | 'skill' | 'plugin' | 'connection'
  brand?: ConnectionBrand
  choice: ComposerInvocation | { kind: 'personalSkill'; id: string }
}

interface InvokeLists {
  tools: LaunchableTool[]
  personalSkills: SkillEntry[]
  bundledSkills: BundledSkillEntry[]
  mcpServers: string[]
}

type ConnectionBrand = 'feishu' | 'dingtalk' | 'facebook' | 'tiktok' | 'appsflyer' | 'figma'
interface ConnectionOption {
  brand: ConnectionBrand
  label: string
  mcpName?: string
}

const EMPTY_LISTS: InvokeLists = { tools: [], personalSkills: [], bundledSkills: [], mcpServers: [] }
const GROUPS: InvokeItem['group'][] = ['tool', 'command', 'skill', 'connection', 'plugin']
const GROUP_ICONS = { tool: Wrench, command: Command, skill: BookOpen, plugin: Layers, connection: Link2 }

const LIST_TTL_MS = 30_000

function cachedCatalog<T>(read: () => Promise<T>) {
  let cache: { value: T; expires: number } | undefined
  let pending: Promise<T> | undefined
  return {
    load(): Promise<T> {
      if (cache && Date.now() < cache.expires) return Promise.resolve(cache.value)
      if (pending) return pending
      const request = Promise.resolve().then(read).then((value) => {
        if (pending === request) cache = { value, expires: Date.now() + LIST_TTL_MS }
        return value
      }).finally(() => {
        if (pending === request) pending = undefined
      })
      pending = request
      return request
    },
    invalidate() {
      cache = undefined
      pending = undefined
    }
  }
}

const toolsCatalog = cachedCatalog(async () => await window.electronAPI.listLaunchableTools?.() ?? [])
const pluginsCatalog = cachedCatalog(async () => await window.electronAPI.listLaunchableTools?.('enabled-plugins') ?? [])
const personalCatalog = cachedCatalog(async () => {
  const result = await window.electronAPI.listSkills?.()
  if (result && !result.ok) throw new Error(result.error)
  return result?.entries ?? []
})
const bundledCatalog = cachedCatalog(async () => {
  const result = await window.electronAPI.listBundledSkills?.()
  if (result && !result.ok) throw new Error(result.error)
  return result?.entries ?? []
})

export function invalidateInvokeLists(): void {
  toolsCatalog.invalidate()
  pluginsCatalog.invalidate()
  personalCatalog.invalidate()
  bundledCatalog.invalidate()
}

export default function InvokePicker({
  triggerRef,
  onClose,
  onPick,
  commands,
  liveSession,
  tray = false
}: {
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onPick: (invocation: ComposerInvocation) => void
  commands: SlashCommand[]
  liveSession: boolean
  tray?: boolean
}) {
  const t = useT()
  const navigate = useNavigate()
  const filterLabel = t(tray ? 'composer.pluginsSearch' : 'composer.invoke.filter')
  const language = useAppStore((s) => s.language)
  const [lists, setLists] = useState<InvokeLists>(EMPTY_LISTS)
  const [loading, setLoading] = useState(4)
  const [connections, setConnections] = useState<ConnectionOption[]>([])
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pendingSkill = useRef<symbol | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  useEffect(() => {
    let cancelled = false
    const load = <K extends keyof InvokeLists>(key: K, read: () => Promise<InvokeLists[K]>) => {
      void Promise.resolve().then(read).then((result) => {
        if (!cancelled) setLists((current) => ({ ...current, [key]: result }))
      }).catch(() => undefined).finally(() => {
        if (!cancelled) setLoading((current) => current - 1)
      })
    }
    // Start MCP immediately and resolve it independently of the native package probes.
    load('mcpServers', async () =>
      (await window.electronAPI.mcpList?.() ?? [])
        .filter(({ enabled, name }) => enabled && isMcpMentionName(name))
        .map(({ name }) => name)
    )
    load('personalSkills', personalCatalog.load)
    load('tools', tray ? pluginsCatalog.load : toolsCatalog.load)
    load('bundledSkills', bundledCatalog.load)
    return () => { cancelled = true }
  }, [tray])

  useEffect(() => {
    if (!tray) return
    let cancelled = false
    const api = window.electronAPI
    const choices: Array<ConnectionOption & { read: () => Promise<{ status: string; connected?: boolean }> }> = [
      { brand: 'feishu', label: t('connections.feishu'), read: api.feishuStatus },
      { brand: 'dingtalk', label: t('connections.dingTalk'), read: api.dingTalkStatus },
      { brand: 'facebook', label: 'Meta Ads', mcpName: 'meta-ads', read: api.metaAdsStatus },
      { brand: 'tiktok', label: 'TikTok Ads', mcpName: 'tiktok-ads', read: api.tiktokStatus },
      { brand: 'appsflyer', label: 'AppsFlyer', mcpName: 'appsflyer', read: api.appsflyerStatus },
      { brand: 'figma', label: 'Figma', mcpName: 'figma', read: api.figmaStatus }
    ]
    setConnections([])
    for (const { read, ...option } of choices) {
      if (!read) continue
      void Promise.resolve().then(read).then(state => {
        if (!cancelled && (state.connected || state.status === 'connected')) {
          setConnections(current => [...current, option])
        }
      }).catch(() => undefined)
    }
    return () => { cancelled = true }
  }, [tray, t])

  useLayoutEffect(() => () => { pendingSkill.current = null }, [])

  const groups = useMemo(() => {
    const rows: InvokeItem[] = []
    const available = new Set(commands.map(({ name }) => `/${name}`))
    const displayed = new Set<string>()
    for (const tool of lists.tools) {
      if (tool.command) {
        if (liveSession && !available.has(tool.command)) continue
        displayed.add(tool.command)
        rows.push({ id: tool.id, label: tool.label, description: tool.description, group: tray ? 'plugin' : 'tool', choice: { kind: 'slash', command: tool.command } })
      } else if (tray) {
        rows.push({ id: tool.id, label: tool.label, description: tool.description, group: 'plugin', choice: { kind: 'insert', text: t('composer.usePlugin', { name: tool.label }) } })
      }
    }
    for (const command of commands) {
      const token = `/${command.name}`
      if (displayed.has(token) || (tray && command.source !== 'skill')) continue
      rows.push({
        id: `cmd:${command.name}`,
        label: token,
        description: command.description,
        group: command.source === 'skill' ? 'skill' : 'command',
        choice: { kind: 'slash', command: token }
      })
    }
    for (const skill of lists.personalSkills) {
      if (skill.kind !== 'markdown') continue
      rows.push({ id: `skill:${skill.id}`, label: skill.name, description: skill.description, group: 'skill', choice: { kind: 'personalSkill', id: skill.id } })
    }
    for (const skill of lists.bundledSkills) {
      rows.push({ id: `bundled:${skill.id}`, label: skill.name, description: skill.description, group: 'skill', choice: { kind: 'skill', text: skill.prompt.trim() } })
    }
    const managed = new Set<string>()
    for (const { brand, label, mcpName } of connections) {
      // Managed MCP connections use the same explicit invocation as typing @.
      // The workspace connectors without an MCP name are invoked by their CLI instructions.
      if (mcpName && !lists.mcpServers.includes(mcpName)) continue
      if (mcpName) managed.add(mcpName)
      rows.push({
        id: `connection:${brand}`, label, brand, group: 'connection',
        choice: mcpName ? { kind: 'mcp', name: mcpName } : { kind: 'insert', text: t('composer.useConnection', { name: label }) }
      })
    }
    for (const name of lists.mcpServers) {
      if (managed.has(name)) continue
      rows.push({ id: `mcp:${name}`, label: name, group: 'plugin', choice: { kind: 'mcp', name } })
    }
    const needle = query.trim().toLowerCase()
    const filtered = needle ? rows.filter(({ label, description, choice, brand }) =>
      label.toLowerCase().includes(needle) || brand?.includes(needle) ||
      description?.toLowerCase().includes(needle) ||
      (choice.kind === 'slash' && choice.command.toLowerCase().includes(needle))
    ) : rows
    return GROUPS.map((group) => ({ group, rows: filtered.filter((item) => item.group === group) }))
      .filter(({ rows }) => rows.length > 0)
  }, [commands, connections, lists, liveSession, query, t, tray])

  const options = groups.flatMap(({ rows }) => rows)
  const activeIndex = Math.max(0, options.findIndex(({ id }) => id === activeId))
  const active = options[activeIndex]
  const optionId = (id: string) => `${listId}-${id}`
  const close = () => {
    pendingSkill.current = null
    onClose()
  }

  const pick = async ({ choice }: InvokeItem) => {
    if (pendingSkill.current) return
    if (choice.kind === 'personalSkill') {
      const request = Symbol()
      pendingSkill.current = request
      setBusy(true)
      const result = await window.electronAPI.readSkill?.(choice.id).catch(() => null)
      if (pendingSkill.current !== request) return
      if (!result?.ok) {
        pendingSkill.current = null
        setBusy(false)
        showNotice('composer.invoke.pickFailed')
        return
      }
      onPickRef.current({
        kind: 'skill',
        text: formatSkillChatMessage(result.entry.name, result.content, language)
      })
    } else {
      onPickRef.current(choice)
    }
    close()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !active) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void pick(active)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const item = options[(activeIndex + step + options.length) % options.length]
      setActiveId(item.id)
      document.getElementById(optionId(item.id))?.scrollIntoView({ block: 'nearest' })
    }
  }

  const title = {
    tool: t('composer.invoke.groupTool'),
    command: t('composer.invoke.groupCommand'),
    skill: t('composer.invoke.groupSkill'),
    connection: t('connections.title'),
    plugin: t('composer.invoke.groupPlugin')
  }

  return (
    <MenuPortal open triggerRef={triggerRef} onClose={close} width={320} maxHeight={480} initialFocusRef={inputRef}>
      <div className="sticky top-0 z-10 bg-ink-850 p-1.5">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveId(null)
          }}
          onKeyDown={handleKeyDown}
          placeholder={filterLabel}
          aria-label={filterLabel}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={active ? optionId(active.id) : undefined}
          className="w-full rounded-lg border border-line bg-ink-900 px-2.5 py-1.5 text-[12.5px] text-cream placeholder-cream-faint outline-none focus:border-accent/40"
        />
      </div>
      <div id={listId} role="listbox" aria-label={filterLabel} aria-busy={busy}>
        {groups.map(({ group, rows }) => {
          const Icon = GROUP_ICONS[group]
          return (
            <div key={group} role="group" aria-label={title[group]} className="mb-1">
              <p className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-cream-faint">
                {title[group]}
              </p>
              {rows.map((item) => (
                <button
                  key={item.id}
                  id={optionId(item.id)}
                  type="button"
                  role="option"
                  aria-selected={active?.id === item.id}
                  disabled={busy}
                  onClick={() => void pick(item)}
                  className="focus-ring flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-overlay aria-selected:bg-overlay disabled:opacity-60"
                >
                  {item.brand ? <BrandIcon brand={item.brand} size={16} /> :
                    <Icon size={15} className="shrink-0 text-cream-dim" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-cream">{item.label}</span>
                    {item.description && (
                      <span className="block truncate text-[11px] text-cream-faint">{item.description}</span>
                    )}
                  </span>
                  {group === 'tool' && item.choice.kind === 'slash' && (
                    <code className="max-w-[45%] truncate text-[10.5px] text-cream-faint">{item.choice.command}</code>
                  )}
                </button>
              ))}
            </div>
          )
        })}
      </div>
      {(loading > 0 || busy) && (
        <p role="status" className="px-2.5 py-2 text-[12px] text-cream-faint">{t('composer.invoke.loading')}</p>
      )}
      {!loading && !busy && options.length === 0 && (
        <p role="status" className="px-2.5 py-2 text-[12px] text-cream-faint">{t('composer.invoke.empty')}</p>
      )}
      {tray && <button type="button" onClick={() => { close(); navigate('/connections') }}
        className="focus-ring sticky -bottom-1 flex w-full items-center gap-2 border-t border-line bg-ink-850 px-2.5 py-2 text-left text-xs text-cream-dim hover:text-cream">
        <Link2 size={15} />{t('composer.manageConnections')}<ChevronRight size={12} className="ml-auto" />
      </button>}
    </MenuPortal>
  )
}
