import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Puzzle,
  Plus,
  RotateCcw,
  FolderOpen,
  FileCode,
  Trash2,
  ArrowUpCircle,
  Sparkles,
  MessageSquareText,
  Palette,
  Wrench,
  Info,
  GripVertical,
  PackageOpen,
  Search,
  Hammer,
  Check,
  Loader2,
  Power,
  MonitorSmartphone,
  Download,
  Pencil,
  Code2
} from 'lucide-react'
import {
  CommunityPackageInfo,
  KimiComputerUseStatus,
  ManagedPluginDescriptor,
  ManagedPluginDetail,
  PackageDescriptor,
  PackageManagerCapabilities,
  PackageResource
} from '@shared/types'
import { useAppStore } from '../store'
import { useT, I18nKey } from '../i18n'
import Logo from '../components/Logo'
import { PluginStudioDialog } from '../components/PluginStudioDialog'

type PageTab = 'installed' | 'marketplace'
type SourceMode = 'github' | 'npm'
type StudioTarget = 'new' | ManagedPluginDetail | null

const CATEGORY_KEYS: Record<string, I18nKey> = {
  web: 'plugins.category.web',
  mcp: 'plugins.category.mcp',
  agents: 'plugins.category.agents',
  quality: 'plugins.category.quality',
  safety: 'plugins.category.safety',
  productivity: 'plugins.category.productivity'
}

type PendingAction =
  | { kind: 'install' }
  | { kind: 'remove' | 'update' | 'toggle'; id: string }
  | null

type DropZone = 'chassis' | 'rack' | 'trash'

const PKG_DRAG_TYPE = 'application/x-omp-package'

const RESOURCE_ICONS: Record<PackageResource['type'], typeof Wrench> = {
  extension: Wrench,
  skill: Sparkles,
  prompt: MessageSquareText,
  theme: Palette
}

function hasPackageDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(PKG_DRAG_TYPE)
}

function hasFileDrag(e: React.DragEvent | DragEvent): boolean {
  return e.dataTransfer?.types.includes('Files') ?? false
}

export default function PackagesPage() {
  const { packages, setPackages } = useAppStore()
  const t = useT()
  const [source, setSource] = useState('')
  const [sourceMode, setSourceMode] = useState<SourceMode>('github')
  const [pending, setPending] = useState<PendingAction>(null)
  const [log, setLog] = useState<{ ok: boolean; text: string } | null>(null)
  const [dragSource, setDragSource] = useState<string | null>(null)
  const [overZone, setOverZone] = useState<DropZone | null>(null)
  const [fileDrag, setFileDrag] = useState(false)
  const [tab, setTab] = useState<PageTab>('installed')
  const [packageCapabilities, setPackageCapabilities] = useState<PackageManagerCapabilities>({
    profile: 'unavailable',
    canToggle: false,
    canUpdate: false
  })
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false)
  const [managedPlugins, setManagedPlugins] = useState<ManagedPluginDescriptor[]>([])
  const [studioTarget, setStudioTarget] = useState<StudioTarget>(null)
  const [managedBusyId, setManagedBusyId] = useState<string | null>(null)
  const [managedError, setManagedError] = useState<string | null>(null)
  const [confirmDeleteManagedId, setConfirmDeleteManagedId] = useState<string | null>(null)
  const [kimiStatus, setKimiStatus] = useState<KimiComputerUseStatus | null>(null)
  const [kimiPending, setKimiPending] = useState(false)
  const [kimiError, setKimiError] = useState<string | null>(null)
  const fileDragDepth = useRef(0)
  const refreshGeneration = useRef(0)
  const managedRefreshGeneration = useRef(0)
  const kimiRefreshGeneration = useRef(0)
  const confirmManagedDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isCurrentOmp = packageCapabilities.profile === 'current'
  const isLegacyPi = packageCapabilities.profile === 'legacy'
  const canUseAssemblyLayout = packageCapabilities.profile === 'legacy' || packageCapabilities.canToggle
  const mounted = packages.filter((p) => p.enabled)
  const parts = packages.filter((p) => !p.enabled)

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    setCapabilitiesLoaded(false)
    try {
      const [nextPackages, capabilities] = await Promise.all([
        window.electronAPI.listPackages(),
        window.electronAPI.getPackageCapabilities()
      ])
      if (generation !== refreshGeneration.current) return
      setPackages(nextPackages)
      setPackageCapabilities(capabilities)
    } catch {
      if (generation !== refreshGeneration.current) return
      setPackageCapabilities({ profile: 'unavailable', canToggle: false, canUpdate: false })
    } finally {
      if (generation === refreshGeneration.current) setCapabilitiesLoaded(true)
    }
  }, [setPackages])

  const refreshManagedPlugins = useCallback(async () => {
    const generation = ++managedRefreshGeneration.current
    try {
      const next = await window.electronAPI.listManagedPlugins()
      if (generation === managedRefreshGeneration.current) {
        setManagedPlugins(next)
        setManagedError(null)
      }
    } catch {
      if (generation === managedRefreshGeneration.current) setManagedError('Could not load handwritten plugins.')
    }
  }, [])

  const refreshKimiStatus = useCallback(async () => {
    const generation = ++kimiRefreshGeneration.current
    setKimiPending(true)
    setKimiError(null)
    try {
      const status = await window.electronAPI.getKimiComputerUseStatus()
      if (generation === kimiRefreshGeneration.current) setKimiStatus(status)
    } catch (error) {
      if (generation === kimiRefreshGeneration.current) {
        setKimiStatus(null)
        setKimiError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (generation === kimiRefreshGeneration.current) setKimiPending(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    void refreshManagedPlugins()
    void refreshKimiStatus()
  }, [refreshKimiStatus, refreshManagedPlugins])

  useEffect(() => {
    if (isCurrentOmp && tab === 'marketplace') setTab('installed')
  }, [isCurrentOmp, tab])

  useEffect(() => {
    return () => {
      if (confirmManagedDeleteTimer.current) clearTimeout(confirmManagedDeleteTimer.current)
    }
  }, [])

  const refreshAll = async () => {
    await Promise.all([refresh(), refreshManagedPlugins(), refreshKimiStatus()])
  }

  const run = async (action: PendingAction, fn: () => Promise<{ ok: boolean; log: string }>) => {
    setPending(action)
    try {
      const result = await fn()
      setLog(result.log ? { ok: result.ok, text: result.log } : null)
      await refresh()
      return result
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setLog({ ok: false, text })
      return { ok: false, log: text }
    } finally {
      setPending(null)
    }
  }

  const handleInstall = async (target?: string) => {
    const value = (target ?? source).trim()
    if (!value || pending) return
    const result = await run({ kind: 'install' }, () => window.electronAPI.installPackage(value))
    if (result.ok && target === undefined) setSource('')
  }

  const openManagedPlugin = async (id: string) => {
    setManagedError(null)
    try {
      const plugin = await window.electronAPI.getManagedPlugin(id)
      if (!plugin) {
        setManagedError('This handwritten plugin is no longer available.')
        await refreshManagedPlugins()
        return
      }
      setStudioTarget(plugin)
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : String(error))
    }
  }

  const syncManagedPlugin = async (id: string) => {
    if (managedBusyId) return
    setManagedError(null)
    setManagedBusyId(id)
    try {
      const result = await window.electronAPI.syncManagedPlugin(id)
      if (!result.ok) setManagedError(result.error || result.log || 'Could not sync the handwritten plugin.')
      await Promise.all([refreshManagedPlugins(), refresh()])
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : String(error))
    } finally {
      setManagedBusyId(null)
    }
  }

  const deleteManagedPlugin = async (id: string) => {
    if (managedBusyId) return
    if (confirmDeleteManagedId !== id) {
      setConfirmDeleteManagedId(id)
      if (confirmManagedDeleteTimer.current) clearTimeout(confirmManagedDeleteTimer.current)
      confirmManagedDeleteTimer.current = setTimeout(() => setConfirmDeleteManagedId(null), 3000)
      return
    }
    setConfirmDeleteManagedId(null)
    if (confirmManagedDeleteTimer.current) clearTimeout(confirmManagedDeleteTimer.current)
    setManagedError(null)
    setManagedBusyId(id)
    try {
      const result = await window.electronAPI.deleteManagedPlugin(id)
      if (!result.ok) setManagedError(result.error || result.log || 'Could not delete the handwritten plugin.')
      await Promise.all([refreshManagedPlugins(), refresh()])
    } catch (error) {
      setManagedError(error instanceof Error ? error.message : String(error))
    } finally {
      setManagedBusyId(null)
    }
  }

  const toggleKimiBridge = async () => {
    if (!kimiStatus || kimiPending) return
    setKimiPending(true)
    setKimiError(null)
    try {
      const result = await window.electronAPI.setKimiComputerUseEnabled(!kimiStatus.configured)
      setKimiStatus(result.status)
      if (!result.ok && result.error && result.error !== 'Cancelled.') setKimiError(result.error)
    } catch (error) {
      setKimiError(error instanceof Error ? error.message : String(error))
    } finally {
      setKimiPending(false)
    }
  }

  const handlePick = async (kind: 'directory' | 'file') => {
    if (pending) return
    try {
      const grant = await window.electronAPI.selectPackageLocalSource(kind)
      if (!grant) return
      await run({ kind: 'install' }, () => window.electronAPI.installPackageLocalSource(grant.id))
    } catch (error) {
      setLog({ ok: false, text: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleRemove = async (pkg: PackageDescriptor) => {
    await run({ kind: 'remove', id: pkg.id }, () => window.electronAPI.removePackage(pkg.id))
  }

  const handleUpdate = async (pkg: PackageDescriptor) => {
    await run({ kind: 'update', id: pkg.id }, () => window.electronAPI.updatePackage(pkg.id))
  }

  const handleToggle = async (pkg: PackageDescriptor, next: boolean) => {
    if (!packageCapabilities.canToggle || pending || pkg.enabled === next) return
    await run({ kind: 'toggle', id: pkg.id }, () => window.electronAPI.setPackageEnabled(pkg.id, next))
  }

  const installDroppedFiles = async (files: FileList | File[]) => {
    if (isCurrentOmp || pending) return
    const file = Array.from(files)[0]
    if (!file) return
    try {
      const grant = await window.electronAPI.grantDroppedPackageLocalSource(file)
      if (!grant) return
      await run({ kind: 'install' }, () => window.electronAPI.installPackageLocalSource(grant.id))
    } catch (error) {
      setLog({ ok: false, text: error instanceof Error ? error.message : String(error) })
    }
  }

  // Finder file drags get a full-window overlay; card drags use the zones.
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (isCurrentOmp || !hasFileDrag(e)) return
      e.preventDefault()
      fileDragDepth.current += 1
      setFileDrag(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!isCurrentOmp && hasFileDrag(e)) e.preventDefault()
    }
    const onDragLeave = (e: DragEvent) => {
      if (isCurrentOmp || !hasFileDrag(e)) return
      fileDragDepth.current = Math.max(0, fileDragDepth.current - 1)
      if (fileDragDepth.current === 0) setFileDrag(false)
    }
    const onDrop = (e: DragEvent) => {
      if (isCurrentOmp || !hasFileDrag(e)) return
      e.preventDefault()
      fileDragDepth.current = 0
      setFileDrag(false)
      if (e.dataTransfer?.files.length) void installDroppedFiles(e.dataTransfer.files)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCurrentOmp, pending])

  const zoneDropProps = (zone: DropZone) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canUseAssemblyLayout || pending || !hasPackageDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = zone === 'trash' ? 'move' : 'move'
      setOverZone(zone)
    },
    onDragLeave: () => {
      setOverZone((current) => (current === zone ? null : current))
    },
    onDrop: (e: React.DragEvent) => {
      setOverZone(null)
      setDragSource(null)
      if (!canUseAssemblyLayout || pending || !hasPackageDrag(e)) return
      e.preventDefault()
      const dragged = e.dataTransfer.getData(PKG_DRAG_TYPE)
      const pkg = packages.find((p) => p.id === dragged)
      if (!pkg) return
      if (zone === 'chassis') void handleToggle(pkg, true)
      else if (zone === 'rack') void handleToggle(pkg, false)
      else void handleRemove(pkg)
    }
  })

  // Border color is chosen by state (not overridden) so the highlight wins
  // regardless of utility order in the generated CSS.
  const zoneClass = (zone: DropZone, base: string) => {
    const state =
      overZone === zone
        ? zone === 'trash'
          ? 'border-red-500/60 bg-red-500/10'
          : 'border-accent/60 bg-accent-soft'
        : zone === 'trash'
          ? 'border-red-500/40'
          : 'border-line-strong'
    return `${base} transition ${state}`
  }

  // The action log also renders next to the rack: a toggle failure triggered
  // from a part card (e.g. enable/disable unsupported on the current omp
  // profile) must be visible from the rack, not only up in the Install box.
  const logBlock = log && log.text ? (
    <pre
      className={`mt-3 max-h-36 overflow-y-auto rounded-lg border px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap ${
        log.ok
          ? 'border-line bg-ink-900 text-cream-dim'
          : 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-300'
      }`}
    >
      {log.text}
    </pre>
  ) : null

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <header className="app-drag flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <div className="flex items-center gap-2.5">
          <Puzzle size={15} className="text-accent" />
          <span className="text-[13px] font-medium text-cream">{t('plugins.title')}</span>
          <span className="text-xs text-cream-faint">
            {!capabilitiesLoaded
              ? t('plugins.loadingCapabilities')
              : isCurrentOmp
                ? t('plugins.omp.subtitle')
                : isLegacyPi
                  ? t('plugins.subtitle')
                  : t('plugins.capabilitiesUnavailable')}
          </span>
        </div>
        <button
          onClick={() => void refreshAll()}
          className="app-no-drag flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
        >
          <RotateCcw size={11} />
          {t('plugins.refresh')}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5 pb-20">
        <div className="mx-auto max-w-[760px] space-y-4">
          {!capabilitiesLoaded ? (
            <section className="flex items-center gap-2.5 rounded-[16px] border border-line bg-ink-850 px-4 py-3 text-xs text-cream-dim shadow-card">
              <Loader2 size={14} className="animate-spin text-accent" />
              {t('plugins.loadingCapabilities')}
            </section>
          ) : !isCurrentOmp && !isLegacyPi ? (
            <section className="flex items-start gap-2.5 rounded-[16px] border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs leading-5 text-cream-dim shadow-card">
              <Info size={14} className="mt-0.5 shrink-0 text-red-600 dark:text-red-300" />
              <div>{t('plugins.capabilitiesUnavailable')}</div>
            </section>
          ) : (
            <>
          {/* Legacy Pi has a GUI marketplace; current OMP owns its native one. */}
          <div className="flex w-fit gap-1 rounded-full border border-line bg-ink-900 p-1">
            {(isCurrentOmp ? (['installed'] as const) : (['installed', 'marketplace'] as const)).map((value) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`rounded-full px-3.5 py-1.5 text-[12px] transition ${
                  tab === value
                    ? 'bg-ink-850 font-medium text-cream shadow-card'
                    : 'text-cream-dim hover:text-cream'
                }`}
              >
                {value === 'installed' ? t('plugins.tab.installed') : t('plugins.tab.marketplace')}
              </button>
            ))}
          </div>

          {tab === 'marketplace' && !isCurrentOmp ? (
            <MarketplaceSection
              packages={packages}
              pending={pending}
              onInstall={handleInstall}
              logBlock={logBlock}
            />
          ) : (
            <>
              {/* Install */}
              <section className="rounded-[16px] border border-line bg-ink-850 p-4 shadow-card">
                <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
                  {isCurrentOmp ? t('plugins.omp.installTitle') : t('plugins.installTitle')}
                </div>
                <div className="mb-2.5 flex w-fit gap-1 rounded-full border border-line bg-ink-900 p-1">
                  {(['github', 'npm'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setSourceMode(mode)}
                      disabled={pending !== null}
                      className={`rounded-full px-3 py-1 text-[11px] transition disabled:opacity-50 ${
                        sourceMode === mode
                          ? 'bg-ink-850 font-medium text-cream shadow-card'
                          : 'text-cream-dim hover:text-cream'
                      }`}
                    >
                      {mode === 'github' ? t('plugins.source.github') : t('plugins.source.npm')}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleInstall()
                    }}
                    placeholder={
                      sourceMode === 'github'
                        ? t('plugins.source.githubPlaceholder')
                        : t('plugins.source.npmPlaceholder')
                    }
                    disabled={pending !== null}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-3 py-2 font-mono text-[13px] text-cream outline-none transition-all placeholder:text-cream-faint focus:border-accent/50 focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-50"
                  />
                  <button
                    onClick={() => void handlePick('directory')}
                    disabled={pending !== null}
                    title={t('plugins.browseFolder')}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-2 text-[12px] whitespace-nowrap text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
                  >
                    <FolderOpen size={12} />
                    {t('plugins.browseFolder')}
                  </button>
                  {!isCurrentOmp && (
                    <button
                      onClick={() => void handlePick('file')}
                      disabled={pending !== null}
                      title={t('plugins.browseFile')}
                      className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-2 text-[12px] whitespace-nowrap text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
                    >
                      <FileCode size={12} />
                      {t('plugins.browseFile')}
                    </button>
                  )}
                  <button
                    onClick={() => handleInstall()}
                    disabled={!source.trim() || pending !== null}
                    className="flex shrink-0 items-center gap-1.5 rounded-full bg-cream px-4 py-2 text-[12px] font-medium whitespace-nowrap text-ink-950 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={12} />
                    {pending?.kind === 'install' ? t('plugins.installing') : t('plugins.install')}
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-cream-faint">
                  {sourceMode === 'github' ? t('plugins.source.githubHint') : t('plugins.source.npmHint')}
                </p>
                {logBlock}
              </section>

              <section className="rounded-[16px] border border-line bg-ink-850 p-4 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
                      {t('plugins.write.title')}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-cream-dim">{t('plugins.write.empty')}</p>
                  </div>
                  <button
                    onClick={() => {
                      setManagedError(null)
                      setStudioTarget('new')
                    }}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-accent/50 hover:text-cream"
                  >
                    <Hammer size={12} />
                    {t('plugins.write.new')}
                  </button>
                </div>
                {managedPlugins.length > 0 && (
                  <div className="mt-3 grid gap-2">
                    {managedPlugins.map((plugin) => {
                      const busy = managedBusyId === plugin.id
                      const confirmingDelete = confirmDeleteManagedId === plugin.id
                      return (
                        <div key={plugin.id} className="flex items-center gap-2 rounded-xl border border-line bg-ink-900/60 px-3 py-2.5">
                          <Code2 size={13} className="shrink-0 text-accent" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[12px] font-medium text-cream">{plugin.displayName || plugin.name}</span>
                              <span className="font-mono text-[10px] text-cream-faint">{plugin.version}</span>
                              <span className={`rounded-full px-1.5 py-0.5 text-[9.5px] ${plugin.syncedAt ? 'bg-emerald-500/10 text-emerald-500' : 'bg-overlay text-cream-faint'}`}>
                                {plugin.syncedAt ? t('plugins.write.synced') : t('plugins.write.unsynced')}
                              </span>
                            </div>
                            {plugin.lastSyncError && (
                              <p className="mt-0.5 truncate text-[10.5px] text-red-500" title={plugin.lastSyncError}>
                                {t('plugins.write.lastSyncFailed', { error: plugin.lastSyncError })}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              onClick={() => void openManagedPlugin(plugin.id)}
                              disabled={busy}
                              title={t('plugins.write.edit')}
                              className="rounded-md p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream disabled:opacity-50"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              onClick={() => void syncManagedPlugin(plugin.id)}
                              disabled={busy}
                              title={t('plugins.write.sync')}
                              className="rounded-md p-1.5 text-cream-faint transition hover:bg-accent-soft hover:text-accent disabled:opacity-50"
                            >
                              {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                            </button>
                            <button
                              onClick={() => void deleteManagedPlugin(plugin.id)}
                              disabled={busy}
                              title={confirmingDelete ? t('plugins.write.deleteConfirm') : t('plugins.write.delete')}
                              className={`rounded-md p-1.5 transition disabled:opacity-50 ${
                                confirmingDelete
                                  ? 'bg-red-500/15 text-red-500'
                                  : 'text-cream-faint hover:bg-red-500/10 hover:text-red-500'
                              }`}
                            >
                              {confirmingDelete ? <Check size={12} /> : <Trash2 size={12} />}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {managedError && (
                  <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-300">
                    {managedError}
                  </p>
                )}
              </section>

              <KimiComputerUseCard
                status={kimiStatus}
                pending={kimiPending}
                error={kimiError}
                onRefresh={() => void refreshKimiStatus()}
                onToggle={() => void toggleKimiBridge()}
              />

              {canUseAssemblyLayout ? (
                <>
                  <section className="rounded-[16px] border border-line bg-ink-850 px-4 py-3 shadow-card">
                    <div className="flex items-start gap-2.5">
                      <Info size={13} className="mt-0.5 shrink-0 text-accent" />
                      <div className="space-y-1 text-xs leading-5 text-cream-dim">
                        <div className="font-medium text-cream">
                          {isCurrentOmp ? t('plugins.omp.usageTitle') : t('plugins.usageTitle')}
                        </div>
                        <div>· {isCurrentOmp ? t('plugins.omp.usage1') : t('plugins.usage1')}</div>
                        <div>· {isCurrentOmp ? t('plugins.omp.usage2') : t('plugins.usage2')}</div>
                        <div>· {isCurrentOmp ? t('plugins.omp.usage3') : t('plugins.usage3')}</div>
                      </div>
                    </div>
                  </section>

                  <section
                    {...zoneDropProps('chassis')}
                    className={zoneClass(
                      'chassis',
                      'rounded-[18px] border-[1.5px] border-dashed bg-ink-850/60 p-4'
                    )}
                  >
                    <div className="mb-3 flex items-center gap-2.5">
                      <Logo size={28} className="shrink-0" />
                      <span className="text-[13px] font-semibold text-cream">
                        {isCurrentOmp ? t('plugins.omp.enabled') : t('plugins.core')}
                      </span>
                      <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] text-accent">
                        {isCurrentOmp
                          ? t('plugins.omp.enabledCount', { count: mounted.length })
                          : t('plugins.mounted', { count: mounted.length })}
                      </span>
                    </div>
                    {mounted.length === 0 ? (
                      <div className="flex flex-col items-center gap-1.5 py-6 text-center">
                        <PackageOpen size={18} className="text-cream-faint" />
                        <span className="text-xs text-cream-dim">
                          {isCurrentOmp
                            ? t('plugins.omp.emptyEnabled')
                            : packages.length === 0
                              ? t('plugins.empty')
                              : t('plugins.emptyMounted')}
                        </span>
                        {!isCurrentOmp && packages.length === 0 && (
                          <span className="text-[11px] text-cream-faint">{t('plugins.emptyHint')}</span>
                        )}
                      </div>
                    ) : (
                      <div className="grid gap-2.5">
                        {mounted.map((pkg) => (
                          <PartCard
                            key={pkg.id}
                            pkg={pkg}
                            pending={pending}
                            draggable
                            canUpdate={packageCapabilities.canUpdate}
                            canToggle={packageCapabilities.canToggle}
                            onDragStateChange={setDragSource}
                            onUpdate={() => handleUpdate(pkg)}
                            onToggle={(next) => void handleToggle(pkg, next)}
                            onRemove={() => void handleRemove(pkg)}
                          />
                        ))}
                      </div>
                    )}
                  </section>

                  <section
                    {...zoneDropProps('rack')}
                    className={zoneClass('rack', 'rounded-[18px] border-[1.5px] border-dashed p-4')}
                  >
                    <div className="mb-3 flex items-center gap-2 px-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
                        {isCurrentOmp ? t('plugins.omp.disabled') : t('plugins.rack')}
                      </span>
                      <span className="rounded-full bg-overlay-strong px-2 py-0.5 font-mono text-[10px] text-cream-dim">
                        {parts.length}
                      </span>
                    </div>
                    {parts.length === 0 ? (
                      <div className="py-4 text-center text-xs text-cream-faint">
                        {isCurrentOmp ? t('plugins.omp.emptyDisabled') : t('plugins.emptyParts')}
                      </div>
                    ) : (
                      <div className="grid gap-2.5">
                        {parts.map((pkg) => (
                          <PartCard
                            key={pkg.id}
                            pkg={pkg}
                            pending={pending}
                            draggable
                            canUpdate={packageCapabilities.canUpdate}
                            canToggle={packageCapabilities.canToggle}
                            onDragStateChange={setDragSource}
                            onUpdate={() => handleUpdate(pkg)}
                            onToggle={(next) => void handleToggle(pkg, next)}
                            onRemove={() => void handleRemove(pkg)}
                          />
                        ))}
                      </div>
                    )}
                    {logBlock}
                  </section>
                </>
              ) : (
                <>
                  <section className="rounded-[16px] border border-line bg-ink-850 px-4 py-3 shadow-card">
                    <div className="flex items-start gap-2.5">
                      <Info size={13} className="mt-0.5 shrink-0 text-accent" />
                      <div className="space-y-1 text-xs leading-5 text-cream-dim">
                        <div className="font-medium text-cream">{t('plugins.omp.nativeControlsUnavailable')}</div>
                        <div>{t('plugins.omp.nativeControlsUnavailableNote')}</div>
                      </div>
                    </div>
                  </section>

                  <section className="rounded-[18px] border border-line-strong bg-ink-850/60 p-4">
                    <div className="mb-3 flex items-center gap-2.5">
                      <PackageOpen size={18} className="text-accent" />
                      <span className="text-[13px] font-semibold text-cream">{t('plugins.omp.installed')}</span>
                      <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] text-accent">
                        {packages.length}
                      </span>
                    </div>
                    {packages.length === 0 ? (
                      <div className="py-5 text-center text-xs text-cream-faint">{t('plugins.omp.empty')}</div>
                    ) : (
                      <div className="grid gap-2.5">
                        {packages.map((pkg) => (
                          <PartCard
                            key={pkg.id}
                            pkg={pkg}
                            pending={pending}
                            draggable={false}
                            canUpdate={packageCapabilities.canUpdate}
                            canToggle={packageCapabilities.canToggle}
                            onDragStateChange={setDragSource}
                            onUpdate={() => handleUpdate(pkg)}
                            onToggle={(next) => void handleToggle(pkg, next)}
                            onRemove={() => void handleRemove(pkg)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </>
          )}
            </>
          )}
        </div>
      </div>

      {/* Uninstall drop zone — appears while dragging a part */}
      {capabilitiesLoaded && canUseAssemblyLayout && dragSource !== null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-5">
          <div
            {...zoneDropProps('trash')}
            className={zoneClass(
              'trash',
              'pointer-events-auto flex items-center gap-2 rounded-xl border-[1.5px] border-dashed bg-ink-850 px-6 py-3 text-xs font-medium text-red-600 dark:text-red-300'
            )}
          >
            <Trash2 size={14} />
            {t('plugins.trashZone')}
          </div>
        </div>
      )}

      {/* Finder file drop overlay */}
      {fileDrag && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm">
          <div className="flex items-center gap-2.5 rounded-xl border-2 border-dashed border-accent bg-ink-850 px-8 py-5 text-sm font-medium text-accent">
            <PackageOpen size={18} />
            {t('plugins.dropToInstall')}
          </div>
        </div>
      )}

      {studioTarget !== null && (
        <PluginStudioDialog
          plugin={studioTarget === 'new' ? undefined : studioTarget}
          onClose={() => setStudioTarget(null)}
          onChanged={async () => {
            await Promise.all([refreshManagedPlugins(), refresh()])
          }}
        />
      )}
    </div>
  )
}

function KimiComputerUseCard({
  status,
  pending,
  error,
  onRefresh,
  onToggle
}: {
  status: KimiComputerUseStatus | null
  pending: boolean
  error: string | null
  onRefresh: () => void
  onToggle: () => void
}) {
  const t = useT()
  const statusKey = status ? (`plugins.kimi.status.${status.readiness}` as I18nKey) : null
  const canToggle = Boolean(status && (status.configured || status.readiness === 'ready'))
  const showDownload = Boolean(status && !status.installed && status.readiness !== 'unsupported-platform')

  return (
    <section className="rounded-[16px] border border-line bg-ink-850 p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <MonitorSmartphone size={14} />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
              {t('plugins.kimi.title')}
            </div>
            <p className="mt-1 text-xs leading-5 text-cream-dim">{t('plugins.kimi.subtitle')}</p>
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={pending}
          title={t('plugins.kimi.refresh')}
          className="rounded-md p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream disabled:opacity-50"
        >
          <RotateCcw size={13} className={pending ? 'animate-spin' : ''} />
        </button>
      </div>

      {status ? (
        <div className="mt-3 rounded-xl border border-line bg-ink-900/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                status.readiness === 'ready'
                  ? 'bg-emerald-500/10 text-emerald-500'
                  : 'bg-overlay text-cream-dim'
              }`}
            >
              {statusKey ? t(statusKey) : ''}
            </span>
            {status.version && <span className="font-mono text-[10px] text-cream-faint">v{status.version}</span>}
            {status.bridgeReachable && (
              <span className="text-[10.5px] text-cream-faint">{t('plugins.kimi.tools', { count: status.toolCount })}</span>
            )}
          </div>
          {status.detail && <p className="mt-1.5 text-[11px] leading-4 text-cream-dim">{status.detail}</p>}
          {status.configured && <p className="mt-1.5 text-[11px] leading-4 text-emerald-500">{t('plugins.kimi.nextSession')}</p>}
          <div className="mt-2.5 flex flex-wrap gap-2">
            {canToggle && (
              <button
                onClick={onToggle}
                disabled={pending}
                className="flex items-center gap-1.5 rounded-full bg-cream px-3.5 py-1.5 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
                {status.configured ? t('plugins.kimi.disable') : t('plugins.kimi.enable')}
              </button>
            )}
            {showDownload && (
              <button
                onClick={() => void window.electronAPI.openExternalUrl(status.downloadUrl)}
                className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
              >
                <Download size={12} />
                {t('plugins.kimi.download')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-ink-900/60 px-3 py-2.5 text-xs text-cream-dim"
          role={error ? 'status' : undefined}
        >
          {error ? <Info size={13} className="shrink-0 text-red-500" /> : <Loader2 size={13} className="animate-spin text-accent" />}
          <span className="min-w-0 flex-1">{error ? t('plugins.kimi.statusUnavailable') : t('plugins.kimi.refresh')}</span>
          {error && (
            <button
              onClick={onRefresh}
              disabled={pending}
              className="shrink-0 rounded-full border border-line px-2 py-1 text-[10.5px] text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
            >
              {t('plugins.kimi.refresh')}
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  )
}

function PartCard({
  pkg,
  pending,
  draggable,
  canUpdate,
  canToggle,
  onDragStateChange,
  onUpdate,
  onToggle,
  onRemove
}: {
  pkg: PackageDescriptor
  pending: PendingAction
  draggable: boolean
  canUpdate: boolean
  canToggle: boolean
  onDragStateChange: (source: string | null) => void
  onUpdate: () => void
  onToggle: (next: boolean) => void
  onRemove: () => void
}) {
  const t = useT()
  const busy = pending !== null && 'id' in pending && pending.id === pkg.id
  const removing = busy && pending?.kind === 'remove'
  const updating = busy && pending?.kind === 'update'
  const toggling = busy && pending?.kind === 'toggle'
  const updatable = canUpdate && (pkg.canUpdate ?? (pkg.kind !== 'local' && !pkg.pinned))
  const [dragging, setDragging] = useState(false)

  return (
    <div
      draggable={draggable && pending === null}
      onDragStart={(e) => {
        if (!draggable) return
        e.dataTransfer.setData(PKG_DRAG_TYPE, pkg.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        onDragStateChange(pkg.id)
      }}
      onDragEnd={() => {
        if (!draggable) return
        setDragging(false)
        onDragStateChange(null)
      }}
      className={`group rounded-xl border bg-ink-850 p-3.5 transition ${
        dragging ? 'border-accent/50 opacity-50' : 'border-line hover:border-ink-600 hover:shadow-card'
      } ${pkg.enabled ? '' : 'opacity-70'}`}
    >
      <div className="flex items-start gap-2.5">
        {draggable && (
          <GripVertical
            size={14}
            className="mt-0.5 shrink-0 cursor-grab text-cream-faint transition group-hover:text-cream-dim active:cursor-grabbing"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                pkg.enabled ? 'bg-emerald-500' : 'bg-cream-faint/50'
              }`}
            />
            <span className="text-[13px] font-semibold text-cream">{pkg.name}</span>
            {pkg.version && (
              <span className="rounded-full bg-overlay-strong px-1.5 py-0.5 font-mono text-[10px] text-cream-dim">
                {pkg.version}
              </span>
            )}
            <span className="rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] uppercase text-accent">
              {pkg.kind === 'local'
                ? t('plugins.kind.local')
                : pkg.kind === 'marketplace'
                  ? t('plugins.kind.marketplace')
                  : pkg.kind}
            </span>
            {pkg.pinned && (
              <span className="rounded-full bg-overlay-strong px-1.5 py-0.5 text-[10px] text-cream-faint">
                {t('plugins.pinned')}
              </span>
            )}
          </div>
          {pkg.description && (
            <div className="mt-1 line-clamp-2 text-xs leading-5 text-cream-dim">
              {pkg.description}
            </div>
          )}
          {pkg.resources.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pkg.resources.map((res, i) => {
                const Icon = RESOURCE_ICONS[res.type]
                return (
                  <span
                    key={`${res.type}-${res.name}-${i}`}
                    className="flex items-center gap-1 rounded-md bg-overlay px-1.5 py-0.5 text-[10.5px] text-cream-dim"
                  >
                    <Icon size={10} className="text-cream-faint" />
                    {t(`plugins.resource.${res.type}`)} · {res.name}
                  </span>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {updatable && (
            <button
              onClick={onUpdate}
              disabled={pending !== null}
              title={updating ? t('plugins.updating') : t('plugins.update')}
              className="rounded-md p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream disabled:opacity-50"
            >
              <ArrowUpCircle size={13} />
            </button>
          )}
          {canToggle && (
            <button
              onClick={() => onToggle(!pkg.enabled)}
              disabled={pending !== null}
              title={
                toggling
                  ? pkg.enabled
                    ? t('plugins.disabling')
                    : t('plugins.enabling')
                  : pkg.enabled
                    ? t('plugins.disable')
                    : t('plugins.enable')
              }
              aria-label={pkg.enabled ? t('plugins.disable') : t('plugins.enable')}
              className={`rounded-md p-1.5 transition disabled:opacity-50 ${
                pkg.enabled
                  ? 'text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-400'
                  : 'text-cream-faint hover:bg-overlay hover:text-cream'
              }`}
            >
              <Power size={13} />
            </button>
          )}
          <button
            onClick={onRemove}
            disabled={pending !== null}
            title={
              removing
                ? t('plugins.removing')
                : t('plugins.uninstall')
            }
            className="rounded-md p-1.5 text-cream-faint transition hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Marketplace — curated GitHub picks, live npm community search, and the
 * build-your-own entry that opens the scaffold form at /plugins/new.
 */
function MarketplaceSection({
  packages,
  pending,
  onInstall,
  logBlock
}: {
  packages: PackageDescriptor[]
  pending: PendingAction
  onInstall: (source: string) => void
  logBlock: React.ReactNode
}) {
  const t = useT()
  const navigate = useNavigate()
  const [curated, setCurated] = useState<CommunityPackageInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CommunityPackageInfo[] | null>(null)
  const [searching, setSearching] = useState(false)

  // Main derives a path-free, non-command marketplace key for this one badge.
  // The renderer never receives or reconstructs a package source string.
  const isInstalled = (pkg: CommunityPackageInfo) =>
    packages.some((p) => {
      const expected = pkg.repo
        ? `github:${pkg.repo.toLowerCase()}`
        : `npm:${pkg.name.toLowerCase()}`
      return p.marketplaceKey === expected
    })

  const installSource = (pkg: CommunityPackageInfo) =>
    pkg.repo ? `git:github.com/${pkg.repo}` : `npm:${pkg.name}`

  useEffect(() => {
    let alive = true
    window.electronAPI
      .searchPackages('', true)
      .then((list) => {
        if (alive) setCurated(list)
      })
      .catch(() => {
        if (alive) setCurated([])
      })
    return () => {
      alive = false
    }
  }, [])

  // Debounced community search against the npm registry
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    let alive = true
    const timer = setTimeout(() => {
      window.electronAPI
        .searchPackages(q)
        .then((list) => {
          if (!alive) return
          setResults(list)
          setSearching(false)
        })
        .catch(() => {
          if (!alive) return
          setResults([])
          setSearching(false)
        })
    }, 400)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query])

  return (
    <section className="space-y-3">
      {logBlock}

      {/* Curated picks — GitHub-hosted, installed via git: */}
      {curated !== null && (
        <div>
          <div className="mb-2 px-1 text-[11px] font-medium text-cream-faint">
            {t('plugins.curated')}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {curated.map((pkg) => (
              <CommunityPackageCard
                key={pkg.repo ?? pkg.name}
                pkg={pkg}
                installed={isInstalled(pkg)}
                disabled={pending !== null}
                onInstall={() => onInstall(installSource(pkg))}
              />
            ))}
          </div>
        </div>
      )}

      {/* Community search */}
      <div className="rounded-[16px] border border-line bg-ink-850 p-4 shadow-card">
        <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
          {t('plugins.community')}
        </div>
        <div className="relative">
          <Search
            size={12}
            className="absolute top-1/2 left-3 -translate-y-1/2 text-cream-faint"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('plugins.communityPlaceholder')}
            className="w-full rounded-full border border-line bg-ink-900 py-2 pr-3 pl-8 text-[12px] text-cream outline-none transition-all placeholder:text-cream-faint focus:border-accent/50 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
        </div>
        {searching && <div className="mt-3 text-xs text-cream-faint">{t('plugins.searching')}</div>}
        {!searching && results !== null && results.length === 0 && (
          <div className="mt-3 text-xs text-cream-faint">{t('plugins.noResults')}</div>
        )}
        {!searching && results !== null && results.length > 0 && (
          <div className="mt-3 grid gap-2.5">
            {results.map((pkg) => (
              <CommunityPackageCard
                key={pkg.name}
                pkg={pkg}
                installed={isInstalled(pkg)}
                disabled={pending !== null}
                onInstall={() => onInstall(installSource(pkg))}
              />
            ))}
          </div>
        )}
      </div>

      {/* Build your own */}
      <button
        onClick={() => navigate('/plugins/new')}
        className="flex w-full items-center gap-3 rounded-[16px] border border-dashed border-line px-4 py-3.5 text-left transition hover:border-accent/60 hover:bg-accent-soft"
      >
        <Hammer size={15} className="shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-cream">{t('plugins.market.buildOwn')}</div>
          <div className="mt-0.5 text-xs text-cream-dim">{t('plugins.market.buildOwnHint')}</div>
        </div>
      </button>
    </section>
  )
}

function CommunityPackageCard({
  pkg,
  installed,
  disabled,
  onInstall
}: {
  pkg: CommunityPackageInfo
  installed: boolean
  disabled: boolean
  onInstall: () => void
}) {
  const t = useT()
  return (
    <div className="flex gap-3 rounded-[14px] border border-line bg-ink-850 p-3.5 transition-all duration-150 ease-standard hover:border-ink-600 hover:shadow-card">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft">
        <Puzzle size={15} strokeWidth={1.8} className="text-accent" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-cream">
            {pkg.name}
          </span>
          {pkg.category && CATEGORY_KEYS[pkg.category] && (
            <span className="rounded-full bg-overlay-strong px-1.5 py-0.5 text-[10px] text-cream-faint">
              {t(CATEGORY_KEYS[pkg.category])}
            </span>
          )}
          {pkg.version && (
            <span className="rounded-full bg-overlay-strong px-1.5 py-0.5 font-mono text-[10px] text-cream-dim">
              {pkg.version}
            </span>
          )}
        </div>
        {pkg.repo && (
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-cream-faint">
            github.com/{pkg.repo}
          </div>
        )}
        {pkg.description && (
          <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-cream-dim">
            {pkg.description}
          </div>
        )}
        <div className="mt-2.5 flex justify-end">
          {installed ? (
            <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-1 text-[10.5px] font-medium text-accent">
              <Check size={10} />
              {t('plugins.installed')}
            </span>
          ) : (
            <button
              onClick={onInstall}
              disabled={disabled}
              className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[10.5px] text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
            >
              <Plus size={10} />
              {t('plugins.install')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
