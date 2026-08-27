import { useEffect, useState } from 'react'
import {
  Check,
  FolderCog,
  Languages,
  Moon,
  RefreshCw,
  Sun,
  Trash2
} from 'lucide-react'
import { CliCapabilities, CliInfo, PermissionMode, UpdaterStatus } from '@shared/types'
import { useAppStore } from '../store'
import { I18nKey, useT } from '../i18n'
import CurrentOmpSettings from '../components/CurrentOmpSettings'
import LegacyPiSettings from '../components/LegacyPiSettings'

/** RPC protocol versions this GUI can drive (mirrors the main-process handshake). */
const SUPPORTED_RPC_PROTOCOLS: readonly number[] = [1, 2]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[16px] border border-line bg-ink-850 shadow-card">
      <div className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
        {title}
      </div>
      <div className="divide-y divide-line/60 px-4">{children}</div>
    </section>
  )
}

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
  'flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream disabled:opacity-40'

const PERMISSION_MODES: { value: PermissionMode; label: I18nKey; note: I18nKey }[] = [
  { value: 'ask', label: 'settings.permissions.ask', note: 'settings.permissionsNote.ask' },
  { value: 'full', label: 'settings.permissions.full', note: 'settings.permissionsNote.full' },
  { value: 'no-bash', label: 'settings.permissions.noBash', note: 'settings.permissionsNote.noBash' },
  { value: 'readonly', label: 'settings.permissions.readonly', note: 'settings.permissionsNote.readonly' }
]

export default function SettingsPage() {
  const { theme, language, setTheme, setLanguage, permissionMode, setPermissionMode } = useAppStore()
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
  const profile = runtimeOverview?.profile
  const isCurrent = profile === 'current'
  const isLegacy = profile === 'legacy'
  // Widened from the literal type `1` so a future protocol bump can render
  // the unsupported state instead of being narrowed away by TS. Only treated
  // as factual when the CLI is actually detected — getCapabilities() defaults
  // the protocol to 1 before any handshake, which would otherwise read as
  // "RPC protocol v1 · Supported" right above a "Not detected" row.
  const ompProtocol: number | null = cli?.available && caps ? caps.protocol : null

  useEffect(() => {
    window.electronAPI.detectCli().then(setCli)
    window.electronAPI.getCapabilities().then(setCaps)
    window.electronAPI.getAppVersion().then(setVersion)
    // Explicit error tracking: a failed overview must NOT fall back to Legacy.
    useAppStore
      .getState()
      .loadRuntimeOverview(true)
      .catch(() => setOverviewError(true))
    useAppStore.getState().loadRuntimeModels()
    window.electronAPI.getStore('notifications').then((v) => setNotificationsState(v ?? true))
    window.electronAPI.getStore('notificationPreviews').then((v) => setNotifyPreviewsState(v ?? false))
  }, [])

  useEffect(() => {
    window.electronAPI.updaterGetStatus().then(setUpdater)
    return window.electronAPI.onUpdaterStatus(setUpdater)
  }, [])

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
    useAppStore
      .getState()
      .loadRuntimeOverview(true)
      .catch(() => setOverviewError(true))
    useAppStore.getState().loadRuntimeModels()
    setDetecting(false)
  }

  const clearRecent = async () => {
    await window.electronAPI.clearRecentWorkspaces()
    useAppStore.getState().setRecentProjects([])
    setCleared(true)
    setTimeout(() => setCleared(false), 1500)
  }

  const showCliSettings = async () => {
    setCliSettingsError(false)
    const opened = await window.electronAPI.showCliSettings()
    if (!opened) setCliSettingsError(true)
  }

  const changePermissionMode = (value: PermissionMode) => {
    setPermissionMode(value)
  }

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
    `flex h-[26px] items-center rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
      active
        ? 'border-line bg-ink-850 text-cream shadow-card'
        : 'border-transparent text-cream-dim hover:text-cream'
    }`

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="app-drag flex h-12 shrink-0 items-center border-b border-line px-4">
        <span className="text-[13px] font-medium text-cream">{t('settings.title')}</span>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[680px] space-y-4">
          {isCurrent ? (
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
                    useAppStore.getState().loadRuntimeOverview(true).catch(() => setOverviewError(true))
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
              <Note>{t('settings.runtimeLoading')}</Note>
            </Section>
          )}

          <Section title={t('settings.permissions')}>
            <Row label={t('settings.permissionMode')}>
              <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
                {PERMISSION_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    onClick={() => changePermissionMode(mode.value)}
                    className={seg(permissionMode === mode.value)}
                  >
                    {t(mode.label)}
                  </button>
                ))}
              </div>
            </Row>
            <Note>{t(PERMISSION_MODES.find((m) => m.value === permissionMode)?.note ?? 'settings.permissionsNote.ask')}</Note>
          </Section>

          <Section title={t('settings.appearance')}>
            <Row label={t('settings.theme')}>
              <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
                <button onClick={() => setTheme('light')} className={seg(theme === 'light')}>
                  <span className="flex items-center gap-1">
                    <Sun size={11} />
                    {t('settings.themeLight')}
                  </span>
                </button>
                <button onClick={() => setTheme('dark')} className={seg(theme === 'dark')}>
                  <span className="flex items-center gap-1">
                    <Moon size={11} />
                    {t('settings.themeDark')}
                  </span>
                </button>
              </div>
            </Row>
            <Row label={t('settings.language')}>
              <div className="flex items-center gap-2">
                <Languages size={13} className="text-cream-faint" />
                <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
                  <button onClick={() => setLanguage('zh')} className={seg(language === 'zh')}>
                    中文
                  </button>
                  <button onClick={() => setLanguage('en')} className={seg(language === 'en')}>
                    English
                  </button>
                </div>
              </div>
            </Row>
          </Section>

          <Section title={t('settings.notifications')}>
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
                {t('settings.showInFinder')}
              </button>
            </Row>
            {cliSettingsError && <Note>{t('settings.cliSettingsUnavailable')}</Note>}
          </Section>

          <Section title={t('settings.data')}>
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
                ) : (
                  <>
                    <Trash2 size={11} />
                    {t('settings.clear')}
                  </>
                )}
              </button>
            </Row>
          </Section>

          <Section title={t('settings.about')}>
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
          </Section>
        </div>
      </div>
    </div>
  )
}
