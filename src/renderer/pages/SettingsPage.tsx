import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bell,
  Brain,
  Check,
  Cpu,
  Database,
  Download,
  FolderCog,
  Info,
  Languages,
  Lightbulb,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  ShieldCheck,
  Sun,
  Trash2
} from 'lucide-react'
import { CliCapabilities, CliInfo, PermissionMode, UpdaterStatus } from '@shared/types'
import { AUTO_COMPACT_THRESHOLD_MIN, AUTO_COMPACT_THRESHOLD_MAX, normalizeAutoCompactThreshold } from '@shared/compaction'
import type { SessionImportResult, SessionImportSource } from '@shared/sessionImport'
import { subscribeUpdaterStatus } from '../lib/updaterStatus'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { fileManagerRevealKey, I18nKey, useT } from '../i18n'
import { runLanguageTransition, runThemeTransition } from '../lib/themeTransition'
import CurrentOmpSettings from '../components/CurrentOmpSettings'
import LegacyPiSettings from '../components/LegacyPiSettings'
import MemorySection from '../components/MemorySection'
import JellyToggle from '../components/effects/JellyToggle'

/** RPC protocol versions this GUI can drive (mirrors the main-process handshake). */
const SUPPORTED_RPC_PROTOCOLS: readonly number[] = [1, 2]

function Section({ title, children, navId }: { title: string; children: React.ReactNode; navId?: string }) {
  return (
    <section id={navId} className="scroll-mt-3 overflow-hidden rounded-[16px] border border-line bg-ink-850 shadow-card">
      <div className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
        {title}
      </div>
      <div className="divide-y divide-line/60 px-4">{children}</div>
    </section>
  )
}

const SETTINGS_NAV = [
  { id: 'settings-nav-runtime', label: 'Oh My Pi' as const, icon: Cpu },
  { id: 'settings-nav-permissions', label: 'settings.permissions' as const, icon: ShieldCheck },
  { id: 'settings-nav-memory', label: 'settings.memory.title' as const, icon: Brain },
  { id: 'settings-nav-appearance', label: 'settings.appearance' as const, icon: Palette },
  { id: 'settings-nav-notifications', label: 'settings.notifications' as const, icon: Bell },
  { id: 'settings-nav-thinking', label: 'settings.thinkingDisplay' as const, icon: Lightbulb },
  { id: 'settings-nav-data', label: 'settings.data' as const, icon: Database },
  { id: 'settings-nav-about', label: 'settings.about' as const, icon: Info }
]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <span className="text-[13px] text-cream">{label}</span>
      {children}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="py-2.5 text-[11px] leading-relaxed text-cream-faint">{children}</p>
}

const buttonCls =
  'focus-ring flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream disabled:opacity-40'

function AutoCompactSetting() {
  const t = useT()
  const [saved, setSaved] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    window.electronAPI.getStore('autoCompactThresholdPercent').then(value => {
      if (active) {
        const percent = normalizeAutoCompactThreshold(value)
        setSaved(percent)
        setInput(String(percent))
      }
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])
  const value = Number(input)
  const valid = input.trim() !== '' && Number.isInteger(value) && value >= AUTO_COMPACT_THRESHOLD_MIN && value <= AUTO_COMPACT_THRESHOLD_MAX
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || saving || value === saved) return
    setSaving(true)
    try {
      const ok = await window.electronAPI.setStore('autoCompactThresholdPercent', value)
      setFailed(!ok)
      if (ok) setSaved(value)
    } catch { setFailed(true) }
    finally { setSaving(false) }
  }
  return <Section title={t('settings.conversation')}>
    <form onSubmit={save} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <label htmlFor="auto-compact-threshold" className="text-[13px] text-cream">{t('settings.compactThreshold')}</label>
      <div className="flex items-center gap-2">
        <input id="auto-compact-threshold" type="number" min={AUTO_COMPACT_THRESHOLD_MIN} max={AUTO_COMPACT_THRESHOLD_MAX} step={1} required
          disabled={saving} value={input} onChange={event => { setInput(event.target.value); setFailed(false) }}
          aria-describedby="auto-compact-note" className="focus-ring w-16 rounded-md border border-line bg-ink-800 px-2 py-1 text-right text-xs text-cream" />
        <span aria-hidden="true" className="text-xs text-cream-dim">%</span>
        <button type="submit" className={buttonCls} disabled={!valid || saved === value || saving}>{t('settings.saveKey')}</button>
      </div>
    </form>
    <p id="auto-compact-note" className="py-2 text-[11px] leading-relaxed text-cream-faint">{t('settings.compactThresholdNote')}</p>
    {failed && <p role="alert" className="py-1 text-xs text-red-500">{t('settings.compactThresholdFailed')}</p>}
  </Section>
}

const SESSION_IMPORT_SOURCES = [
  { source: 'codex', label: 'Codex' },
  { source: 'claude', label: 'Claude Code' }
] as const

function SessionImportRows() {
  const t = useT()
  const [running, setRunning] = useState<SessionImportSource | null>(null)
  const [results, setResults] = useState<Partial<Record<SessionImportSource, SessionImportResult>>>({})

  async function runImport(source: SessionImportSource, chooseFolder = false) {
    setRunning(source)
    try {
      const result = await window.electronAPI.importAgentHistory(source, chooseFolder)
      if (!result.ok && result.error === 'cancelled') return
      setResults(previous => ({ ...previous, [source]: result }))
      if (result.ok && result.imported > 0) {
        const state = useAppStore.getState()
        void state.loadAllHistorySessions()
        void state.loadHistorySessions(state.currentWorkspace?.id ?? null)
      }
    } catch {
      setResults(previous => ({ ...previous, [source]: { ok: false, error: 'import-failed' } }))
    } finally {
      setRunning(null)
    }
  }

  return <div role="group" aria-labelledby="settings-history-import-heading" className="py-2.5">
    <h3 id="settings-history-import-heading" className="text-[13px] font-medium text-cream">
      {t('settings.importHistory.heading')}
    </h3>
    <p className="mt-1 text-[11px] leading-relaxed text-cream-faint">{t('settings.importHistory.note')}</p>
    {SESSION_IMPORT_SOURCES.map(({ source, label }) => {
      const result = results[source]
      const empty = result?.ok && !(result.imported || result.duplicates || result.skipped || result.failed)
      const summary = running === source ? t('settings.importHistory.running') : empty
        ? t('settings.importHistory.empty')
        : result?.ok ? t('settings.importHistory.result', {
          imported: result.imported, duplicates: result.duplicates, skipped: result.skipped, failed: result.failed
        })
        : result?.error === 'source-unavailable' ? t('settings.importHistory.sourceUnavailable')
        : result ? t('settings.importHistory.error') : ''
      return (
        <div key={source}>
          <Row label={label}>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={buttonCls}
                disabled={running !== null}
                aria-label={t('settings.importHistory.runSource', { source: label })}
                onClick={() => void runImport(source)}
              >
                <Download size={11} />
                {t('settings.importHistory.run')}
              </button>
              <button
                type="button"
                className={buttonCls}
                disabled={running !== null}
                aria-label={t('settings.importHistory.chooseSource', { source: label })}
                onClick={() => void runImport(source, true)}
              >
                {t('settings.importHistory.choose')}
              </button>
            </div>
          </Row>
          <div role="status" aria-live="polite">
            {summary && <p className="pb-2 text-[11px] text-cream-dim">{summary}</p>}
            {running !== source && result?.ok && result.compressed > 0 && (
              <p className="pb-2 text-[11px] text-cream-faint">{t('settings.importHistory.compressed', { count: result.compressed })}</p>
            )}
            {running !== source && result?.ok && result.defaultWorkspace > 0 && (
              <p className="pb-2 text-[11px] text-cream-faint">{t('settings.importHistory.defaultWorkspace', { count: result.defaultWorkspace })}</p>
            )}
          </div>
        </div>
      )
    })}
  </div>
}

const PERMISSION_MODES: { value: PermissionMode; label: I18nKey; note: I18nKey }[] = [
  { value: 'ask', label: 'settings.permissions.ask', note: 'settings.permissionsNote.ask' },
  { value: 'full', label: 'settings.permissions.full', note: 'settings.permissionsNote.full' },
  // Plain-language label (no jargon): the pre-added desc key doubles as the
  // display label, matching the composer PermissionPicker.
  { value: 'no-bash', label: 'permission.noBash.short', note: 'settings.permissionsNote.noBash' },
  { value: 'readonly', label: 'settings.permissions.readonly', note: 'settings.permissionsNote.readonly' }
]

export default function SettingsPage() {
  const { theme, language, setTheme, setLanguage, permissionMode, setPermissionMode, themeSource, setThemeSource } = useAppStore(
    useShallow((s) => ({
      theme: s.theme,
      language: s.language,
      setTheme: s.setTheme,
      setLanguage: s.setLanguage,
      permissionMode: s.permissionMode,
      setPermissionMode: s.setPermissionMode,
      themeSource: s.themeSource,
      setThemeSource: s.setThemeSource
    }))
  )
  const thinkingAutoExpand = useAppStore((s) => s.thinkingAutoExpand)
  const thinkingCollapseTiming = useAppStore((s) => s.thinkingCollapseTiming)
  const composerSendMagnetism = useAppStore(s => s.composerSendMagnetism)
  const setComposerSendMagnetism = useAppStore(s => s.setComposerSendMagnetism)
  const t = useT()
  const [cli, setCli] = useState<CliInfo | null>(null)
  const [caps, setCaps] = useState<CliCapabilities | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [version, setVersion] = useState('')
  const [notifications, setNotificationsState] = useState(true)
  const [notifyPreviews, setNotifyPreviewsState] = useState(false)
  const [updater, setUpdater] = useState<UpdaterStatus>({ status: 'idle' })
  const [cliSettingsError, setCliSettingsError] = useState(false)

  // Runtime profile decides which settings surface applies: current (omp
  // config/RPC-backed) vs legacy (auth.json/settings.json file-backed). The
  // two surfaces are physically separate components — no shared mutations.
  const runtimeOverview = useAppStore((s) => s.runtimeOverview)
  const [overviewError, setOverviewError] = useState(false)
  // True while a forced overview probe is in flight. The probe self-heals a
  // stale/partial overview a second or two later; knowing it is still running
  // lets the UI keep a quiet loading row instead of flashing the error state.
  // Starts true: the mount effect fires a probe immediately, and the first
  // paint must already treat the probe as pending.
  const [overviewProbing, setOverviewProbing] = useState(true)
  const profile = runtimeOverview?.profile
  const isCurrent = profile === 'current'
  const isLegacy = profile === 'legacy'
  // Widened from the literal type `1` so a future protocol bump can render
  // the unsupported state instead of being narrowed away by TS. Only treated
  // as factual when the CLI is actually detected — getCapabilities() defaults
  // the protocol to 1 before any handshake, which would otherwise read as
  // "RPC protocol v1 · Supported" right above a "Not detected" row.
  const ompProtocol: number | null = cli?.available && caps ? caps.protocol : null

  // One forced overview probe with its in-flight window tracked. The probe
  // usually completes within a second or two and repopulates (or replaces) a
  // stale overview; only a probe that settles into failure is an error.
  const probeOverview = () => {
    setOverviewProbing(true)
    useAppStore
      .getState()
      .loadRuntimeOverview(true)
      .catch(() => setOverviewError(true))
      .finally(() => setOverviewProbing(false))
  }

  useEffect(() => {
    window.electronAPI.detectCli().then(setCli)
    window.electronAPI.getCapabilities().then(setCaps)
    window.electronAPI.getAppVersion().then(setVersion)
    // Explicit error tracking: a failed overview must NOT fall back to Legacy.
    probeOverview()
    useAppStore.getState().loadRuntimeModels()
    window.electronAPI.getStore('notifications').then((v) => setNotificationsState(v ?? true))
    window.electronAPI.getStore('notificationPreviews').then((v) => setNotifyPreviewsState(v ?? false))
    // Self-heal the About version row: a cold first probe can miss its
    // timeout; the main side re-probes on later getCapabilities calls, so
    // re-fetch once after a delay instead of showing 未检测到 forever.
    const capsHealTimer = setTimeout(() => {
      window.electronAPI.getCapabilities().then((next) => {
        setCaps((prev) => (prev?.cliVersion ? prev : next))
      })
    }, 12_000)
    return () => clearTimeout(capsHealTimer)
  }, [])

  useEffect(() => subscribeUpdaterStatus(setUpdater), [])

  // "Already up to date" is transient — fall back to the bare check button.
  useEffect(() => {
    if (updater.status !== 'none') return
    const timer = setTimeout(() => setUpdater({ status: 'idle' }), 5000)
    return () => clearTimeout(timer)
  }, [updater.status])

  const redetect = async () => {
    setDetecting(true)
    const info = await window.electronAPI.detectCli(true)
    setCli(info)
    // detectCli(true) also drops the capabilities cache — re-probe so the
    // About rows don't show a stale version after a CLI install/upgrade.
    window.electronAPI.getCapabilities().then(setCaps)
    useAppStore.getState().setCliAvailable(info.available)
    // The runtime profile may have changed with the CLI — refresh the top
    // section too, not just this card.
    probeOverview()
    useAppStore.getState().loadRuntimeModels()
    setDetecting(false)
  }

  const [clearConfirming, setClearConfirming] = useState(false)
  const clearConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearRecent = async () => {
    // One click wipes the whole recent-projects list — make the user mean it.
    if (!clearConfirming) {
      setClearConfirming(true)
      if (clearConfirmTimer.current) clearTimeout(clearConfirmTimer.current)
      clearConfirmTimer.current = setTimeout(() => setClearConfirming(false), 3000)
      return
    }
    if (clearConfirmTimer.current) clearTimeout(clearConfirmTimer.current)
    setClearConfirming(false)
    await window.electronAPI.clearRecentWorkspaces()
    useAppStore.getState().setRecentProjects([])
    setCleared(true)
    setTimeout(() => setCleared(false), 1500)
  }

  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [diagnosticsExportedPath, setDiagnosticsExportedPath] = useState('')
  const [diagnosticsExportFailed, setDiagnosticsExportFailed] = useState(false)
  const exportDiagnostics = async () => {
    setExportingDiagnostics(true)
    setDiagnosticsExportedPath('')
    setDiagnosticsExportFailed(false)
    try {
      const result = await window.electronAPI.exportDiagnostics()
      if (result.ok && result.path) {
        setDiagnosticsExportedPath(result.path)
      } else {
        setDiagnosticsExportFailed(true)
      }
    } catch {
      // A failed export must not just stop spinning with no feedback.
      setDiagnosticsExportFailed(true)
    } finally {
      setExportingDiagnostics(false)
    }
  }

  // 开发者元素（Git 分支 chip 等）：默认关闭，产品界面保持投放师视角。
  const [devChrome, setDevChromeState] = useState(false)
  useEffect(() => {
    window.electronAPI.getStore('showDevChrome').then((value) => setDevChromeState(Boolean(value)))
  }, [])
  const setDevChrome = (value: boolean) => {
    setDevChromeState(value)
    window.electronAPI.setStore('showDevChrome', value)
  }

  const showCliSettings = async () => {
    setCliSettingsError(false)
    const opened = await window.electronAPI.showCliSettings()
    if (!opened) setCliSettingsError(true)
  }

  const changePermissionMode = (value: PermissionMode) => {
    setPermissionMode(value)
  }

  // A stale 'current' overview with an empty provider list makes the model
  // section render its "couldn't load runtime settings" error even though a
  // fresh probe is mid-flight and usually repopulates the list. While that
  // probe is pending, swap the section for a quiet loading row; once the
  // probe settles (providers present, or still empty on a finished probe),
  // the normal surfaces — form or definitive error — take over again.
  const probingStaleOverview =
    overviewProbing &&
    runtimeOverview !== null &&
    runtimeOverview.profile === 'current' &&
    runtimeOverview.providers.length === 0

  const changeNotifications = async (value: boolean) => {
    setNotificationsState(value)
    await window.electronAPI.setStore('notifications', value)
  }

  const changeNotifyPreviews = async (value: boolean) => {
    setNotifyPreviewsState(value)
    await window.electronAPI.setStore('notificationPreviews', value)
  }

  const checkUpdates = async () => {
    setUpdater(await window.electronAPI.updaterCheck())
  }

  const downloadUpdate = async () => {
    setUpdater(await window.electronAPI.updaterDownload())
  }

  const seg = (active: boolean) =>
    `focus-ring flex min-h-8 items-center rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
      active
        ? 'border-line bg-ink-850 text-cream shadow-card'
        : 'border-transparent text-cream-dim hover:text-cream'
    }`

  /** Segmented control with a sliding pill indicator (学 dsh 的 SegmentedControl)：
   *  the raised pill slides under the selected segment instead of each
   *  segment painting its own border. Equal-width tracks keep the math pure CSS. */
  const Segmented = <T extends string>({ value, options, onChange, ariaLabel }: {
    value: T
    options: Array<{ value: T; label: React.ReactNode }>
    onChange: (value: T, event?: React.MouseEvent<HTMLButtonElement>) => void
    ariaLabel?: string
  }) => {
    const index = Math.max(0, options.findIndex((option) => option.value === value))
    return (
      <div role="group" aria-label={ariaLabel} className="relative flex rounded-full border border-line bg-ink-800 p-0.5">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0.5 rounded-full bg-ink-850 shadow-card transition-[left] duration-200 [transition-timing-function:var(--ease-out)]"
          style={{
            width: `calc((100% - 4px) / ${options.length})`,
            left: `calc(2px + ${index} * (100% - 4px) / ${options.length})`
          }}
        />
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={(event) => onChange(option.value, event)}
            className={`focus-ring relative z-[1] flex min-h-8 items-center justify-center px-2 text-[12px] font-medium transition-colors ${
              option.value === value ? 'text-cream' : 'text-cream-dim hover:text-cream'
            }`}
            style={{ width: `calc((100% - 4px) / ${options.length})` }}
          >
            {option.label}
          </button>
        ))}
      </div>
    )
  }

  // 左侧导航：锚点列表 + 滚动高亮（内容多了一屏放不下，学 dsh/kimi 的设置页）。
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [activeNav, setActiveNav] = useState(SETTINGS_NAV[0].id)
  const handleSettingsScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    if (container.scrollTop > 0 && container.scrollHeight - container.scrollTop - container.clientHeight <= 2) {
      setActiveNav(SETTINGS_NAV[SETTINGS_NAV.length - 1].id)
      return
    }
    const containerTop = container.getBoundingClientRect().top
    let current = SETTINGS_NAV[0].id
    for (const item of SETTINGS_NAV) {
      const el = document.getElementById(item.id)
      if (el && el.getBoundingClientRect().top - containerTop <= 40) current = item.id
    }
    setActiveNav(current)
  }, [])
  const scrollToSection = (id: string) => {
    const el = document.getElementById(id)
    const container = scrollContainerRef.current
    if (!el || !container) return
    const top = container.scrollTop + el.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
    container.scrollTo({ top, behavior: 'instant' })
    setActiveNav(id)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="app-drag flex h-12 shrink-0 items-center border-b border-line px-4">
        <span className="text-[13px] font-medium text-cream">{t('settings.title')}</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label={t('settings.nav')} className="hidden w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-3 min-[900px]:flex">
          {SETTINGS_NAV.map((item) => {
            const Icon = item.icon
            const active = activeNav === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => scrollToSection(item.id)}
                aria-current={active ? 'true' : undefined}
                className={`focus-ring flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition ${active ? 'bg-overlay font-medium text-cream' : 'text-cream-dim hover:bg-overlay/60 hover:text-cream'}`}
              >
                <Icon size={13} className={active ? 'text-accent' : 'text-cream-faint'} aria-hidden="true" />
                <span className="truncate">{item.label === 'Oh My Pi' ? item.label : t(item.label)}</span>
              </button>
            )
          })}
        </nav>
        <div ref={scrollContainerRef} onScroll={handleSettingsScroll} className="relative min-w-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[680px] space-y-4">
          <div id="settings-nav-runtime">
          {isCurrent && !probingStaleOverview ? (
            <CurrentOmpSettings />
          ) : isLegacy ? (
            <LegacyPiSettings />
          ) : overviewError ? (
            <Section title="Oh My Pi">
              <Row label={t('settings.ompCompatibility')}>
                <span className="text-xs text-red-500">{t('settings.runtimeError')}</span>
              </Row>
              <Note>
                <button
                  onClick={() => {
                    setOverviewError(false)
                    probeOverview()
                  }}
                  className={buttonCls}
                >
                  <RefreshCw size={11} />
                  {t('settings.runtimeRetry')}
                </button>
              </Note>
            </Section>
          ) : (
            <Section title="Oh My Pi">
              <div className="flex items-center gap-2 py-2.5 text-[11px] text-cream-faint">
                <RefreshCw size={11} className="animate-spin" />
                {t('settings.runtimeLoading')}
              </div>
            </Section>
          )}

          </div>

          <Section navId="settings-nav-permissions" title={t('settings.permissions')}>
            <Row label={t('settings.permissionMode')}>
              <Segmented
                ariaLabel={t('settings.permissionMode')}
                value={permissionMode}
                onChange={(value) => changePermissionMode(value)}
                options={PERMISSION_MODES.map((mode) => ({ value: mode.value, label: t(mode.label) }))}
              />
            </Row>
            <Note>{t(PERMISSION_MODES.find((m) => m.value === permissionMode)?.note ?? 'settings.permissionsNote.ask')}</Note>
          </Section>

          <div id="settings-nav-memory"><MemorySection /></div>

          <Section navId="settings-nav-appearance" title={t('settings.appearance')}>
            <Row label={`${t('settings.language')} / ${language === 'zh' ? 'Language' : '语言'}`}>
              <div className="flex items-center gap-2">
                <Languages size={14} className="text-cream-faint" aria-hidden="true" />
                <Segmented
                  ariaLabel={t('settings.language')}
                  value={language}
                  onChange={(value, event) => runLanguageTransition(() => setLanguage(value), event ? { x: event.clientX, y: event.clientY } : undefined)}
                  options={[
                    { value: 'zh' as const, label: t('settings.languageZh') },
                    { value: 'en' as const, label: t('settings.languageEn') }
                  ]}
                />
              </div>
            </Row>
            <Row label={t('settings.theme')}>
              <div role="group" aria-label={t('settings.theme')} className="flex rounded-full border border-line bg-ink-800 p-0.5">
                <button type="button" aria-pressed={themeSource === 'manual' && theme === 'light'} onClick={(e) => runThemeTransition(() => setTheme('light'), { x: e.clientX, y: e.clientY }, 'light')} className={seg(themeSource === 'manual' && theme === 'light')}>
                  <span className="flex items-center gap-1">
                    <Sun size={11} />
                    {t('settings.themeLight')}
                  </span>
                </button>
                <button type="button" aria-pressed={themeSource === 'manual' && theme === 'dark'} onClick={(e) => runThemeTransition(() => setTheme('dark'), { x: e.clientX, y: e.clientY }, 'dark')} className={seg(themeSource === 'manual' && theme === 'dark')}>
                  <span className="flex items-center gap-1">
                    <Moon size={11} />
                    {t('settings.themeDark')}
                  </span>
                </button>
                <button type="button" aria-pressed={themeSource === 'system'} onClick={() => setThemeSource('system')} className={seg(themeSource === 'system')}>
                  <span className="flex items-center gap-1">
                    <Monitor size={11} />
                    {t('settings.themeSystem')}
                  </span>
                </button>
              </div>
            </Row>
            <Row label={t('settings.composerSendMagnetism')}>
              <JellyToggle size="sm" checked={composerSendMagnetism} onChange={setComposerSendMagnetism}
                aria-label={t('settings.composerSendMagnetism')} />
            </Row>
            <Row label={t('settings.devChrome')}>
              <div className="flex items-center gap-2">
                <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
                  <button onClick={() => setDevChrome(false)} className={seg(!devChrome)}>
                    {t('settings.devChromeOff')}
                  </button>
                  <button onClick={() => setDevChrome(true)} className={seg(devChrome)}>
                    {t('settings.devChromeOn')}
                  </button>
                </div>
                <span className="text-[11px] text-cream-faint">{t('settings.devChromeHint')}</span>
              </div>
            </Row>
          </Section>

          <Section navId="settings-nav-notifications" title={t('settings.notifications')}>
            <Row label={t('settings.notifyCompletion')}>
              <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
                <button onClick={() => changeNotifications(true)} className={seg(notifications)}>
                  {t('settings.on')}
                </button>
                <button onClick={() => changeNotifications(false)} className={seg(!notifications)}>
                  {t('settings.off')}
                </button>
              </div>
            </Row>
            <Note>{t('settings.notifyCompletionNote')}</Note>
            <Row label={t('settings.notifyPreviews')}>
              <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
                <button onClick={() => changeNotifyPreviews(true)} className={seg(notifyPreviews)}>
                  {t('settings.on')}
                </button>
                <button onClick={() => changeNotifyPreviews(false)} className={seg(!notifyPreviews)}>
                  {t('settings.off')}
                </button>
              </div>
            </Row>
            <Note>{t('settings.notifyPreviewsNote')}</Note>
          </Section>

          {isLegacy ? <Section title={t('settings.conversation')}>
            <Note>{t('settings.compactLegacy')}</Note>
          </Section> : <AutoCompactSetting />}

          <Section navId="settings-nav-thinking" title={t('settings.thinkingDisplay')}>
            <Row label={t('settings.thinkingAutoExpand')}>
              <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
                <button onClick={() => useAppStore.getState().setThinkingAutoExpand(true)} className={seg(thinkingAutoExpand)}>
                  {t('settings.on')}
                </button>
                <button onClick={() => useAppStore.getState().setThinkingAutoExpand(false)} className={seg(!thinkingAutoExpand)}>
                  {t('settings.off')}
                </button>
              </div>
            </Row>
            <Note>{t('settings.thinkingAutoExpandNote')}</Note>
            <Row label={t('settings.thinkingCollapseTiming')}>
              <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
                <button onClick={() => useAppStore.getState().setThinkingCollapseTiming('on-complete')} className={seg(thinkingCollapseTiming === 'on-complete')}>
                  {t('settings.thinkingCollapseOnComplete')}
                </button>
                <button onClick={() => useAppStore.getState().setThinkingCollapseTiming('until-next-input')} className={seg(thinkingCollapseTiming === 'until-next-input')}>
                  {t('settings.thinkingCollapseNextInput')}
                </button>
              </div>
            </Row>
            <Note>{t('settings.thinkingCollapseTimingNote')}</Note>
          </Section>

          <Section title="Oh My Pi CLI">
            <Row label={t('settings.cliStatus')}>
              <span
                className={`flex items-center gap-1.5 text-xs font-medium ${
                  cli?.available ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    cli?.available ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
                {cli?.available ? t('settings.cliAvailable') : t('settings.cliMissing')}
              </span>
            </Row>
            <Row label={t('settings.cliPath')}>
              <span className="max-w-[280px] truncate font-mono text-xs text-cream-dim">
                {cli?.path || '—'}
              </span>
            </Row>
            <Row label={t('settings.redetect')}>
              <button onClick={redetect} disabled={detecting} className={buttonCls}>
                <RefreshCw size={11} className={detecting ? 'animate-spin' : ''} />
                {detecting ? t('settings.detecting') : t('settings.redetect')}
              </button>
            </Row>
            {cli?.available === false && (
              <Row label={t('settings.cliInstall')}>
                <button
                  onClick={() => useAppStore.getState().setSetupComplete(false)}
                  className={buttonCls}
                >
                  {t('settings.cliInstall')}
                </button>
              </Row>
            )}
            <Row
              label={
                cli?.available && cli.command === 'omp'
                  ? t('settings.ompConfigDirectory')
                  : t('settings.cliSettingsFile')
              }
            >
              <button onClick={showCliSettings} disabled={!cli?.available} className={buttonCls}>
                <FolderCog size={11} />
                {t(fileManagerRevealKey())}
              </button>
            </Row>
            {cliSettingsError && <Note>{t('settings.cliSettingsUnavailable')}</Note>}
          </Section>

          <Section navId="settings-nav-data" title={t('settings.data')}>
            <SessionImportRows />
            <Row label={t('settings.clearRecent')}>
              <button
                onClick={clearRecent}
                className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-red-500/40 hover:text-red-500"
              >
                {cleared ? (
                  <>
                    <Check size={11} className="text-emerald-500" />
                    {t('settings.cleared')}
                  </>
                ) : clearConfirming ? (
                  <>
                    <Trash2 size={11} />
                    {t('settings.clearConfirm')}
                  </>
                ) : (
                  <>
                    <Trash2 size={11} />
                    {t('settings.clear')}
                  </>
                )}
              </button>
            </Row>
          </Section>

          <Section navId="settings-nav-about" title={t('settings.about')}>
            <Row label={t('settings.version')}>
              <span className="font-mono text-xs text-cream-dim">{version || '—'}</span>
            </Row>
            <Row label={t('settings.update')}>
              <div className="flex items-center gap-2">
                {(updater.status === 'idle' || updater.status === 'none') && (
                  <>
                    <button onClick={checkUpdates} className={buttonCls}>
                      <RefreshCw size={11} />
                      {t('settings.checkUpdate')}
                    </button>
                    {updater.status === 'none' && (
                      <span className="text-xs text-cream-faint">{t('settings.updateNone')}</span>
                    )}
                  </>
                )}
                {updater.status === 'checking' && (
                  <span className="flex items-center gap-1.5 text-xs text-cream-dim">
                    <RefreshCw size={11} className="animate-spin" />
                    {t('settings.checking')}
                  </span>
                )}
                {updater.status === 'available' && (
                  <>
                    <span className="text-xs text-cream-dim">
                      {t('settings.updateAvailable', { version: updater.version })}
                    </span>
                    <button onClick={downloadUpdate} className={buttonCls}>
                      {t('settings.downloadUpdate')}
                    </button>
                  </>
                )}
                {(updater.status === 'downloading' || updater.status === 'progress') && (
                  <span className="flex items-center gap-1.5 text-xs text-cream-dim">
                    <RefreshCw size={11} className="animate-spin" />
                    {t('settings.downloading')}
                    {updater.status === 'progress' ? ` ${updater.percent}%` : ''}
                  </span>
                )}
                {updater.status === 'downloaded' && (
                  <>
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      {t('settings.updateReady', { version: updater.version })}
                    </span>
                    <button
                      onClick={() => window.electronAPI.updaterQuitAndInstall()}
                      className={buttonCls}
                    >
                      {t('settings.restartInstall')}
                    </button>
                  </>
                )}
                {updater.status === 'error' && (
                  <>
                    <span className="text-xs text-red-500">{t('settings.updateError')}</span>
                    <button onClick={checkUpdates} className={buttonCls}>
                      {t('settings.updateRetry')}
                    </button>
                    <button
                      onClick={() => window.electronAPI.updaterOpenReleasePage()}
                      className={buttonCls}
                    >
                      {t('settings.updateOpenPage')}
                    </button>
                  </>
                )}
                {updater.status === 'dev' && (
                  <span className="text-xs text-cream-faint">{t('settings.updateDevMode')}</span>
                )}
              </div>
            </Row>
            {updater.status === 'error' && (
              <Note>
                <span className="text-red-500">{updater.message}</span>
              </Note>
            )}
            <Row label="Oh My Pi">
              <span className="font-mono text-xs text-cream-dim">
                {caps?.cliVersion ? `v${caps.cliVersion}` : t('settings.ompNotDetected')}
              </span>
            </Row>
            <Row label={t('settings.ompProtocol')}>
              <span className="font-mono text-xs text-cream-dim">
                {ompProtocol === null
                  ? '—'
                  : `v${ompProtocol}${caps?.protocolVersions?.length ? ` · ${t('settings.ompProtocolSupported')}: ${caps.protocolVersions.map((v) => `v${v}`).join(', ')}` : ''}`}
              </span>
            </Row>
            <Row label={t('settings.ompCompatibility')}>
              {ompProtocol === null ? (
                <span className="text-xs text-cream-faint">—</span>
              ) : SUPPORTED_RPC_PROTOCOLS.includes(ompProtocol) ? (
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  {t('settings.ompCompatSupported')}
                </span>
              ) : (
                <span className="text-xs text-red-500">{t('settings.ompCompatUnsupported')}</span>
              )}
            </Row>
            <Row label={t('settings.diagnostics')}>
              <div className="flex items-center gap-2">
                <button onClick={exportDiagnostics} disabled={exportingDiagnostics} className={buttonCls}>
                  {exportingDiagnostics ? <RefreshCw size={11} className="animate-spin" /> : <Download size={11} />}
                  {exportingDiagnostics ? t('settings.diagnosticsExporting') : t('settings.diagnosticsExport')}
                </button>
                {diagnosticsExportFailed && (
                  <span className="text-[11px] text-red-500">{t('settings.exportFailed')}</span>
                )}
                {diagnosticsExportedPath && (
                  <span className="max-w-[240px] truncate font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                    {diagnosticsExportedPath}
                  </span>
                )}
              </div>
            </Row>
          </Section>
        </div>
        </div>
      </div>
    </div>
  )
}
