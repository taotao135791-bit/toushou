import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, FileSpreadsheet, FolderOpen, Loader2, MessageSquareText, Save, X } from 'lucide-react'
import { LocaleType, createUniver } from '@univerjs/presets'
import type { FUniver, IWorkbookData, Univer } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import type { FWorkbook } from '@univerjs/preset-sheets-core'
import sheetsZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import sheetsEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import '@univerjs/preset-sheets-core/lib/index.css'
import { FileGrant } from '@shared/types'
import {
  OfficeWorkbookSnapshot,
  OfficeWorkbookWarning,
  sanitizeOfficeSnapshot
} from '@shared/officeWorkbook'
import { buildOfficeChatPrompt, snapshotHasData } from '@shared/officeChat'
import { useAppStore } from '../store'
import { useT } from '../i18n'

const UNIVER_APP_VERSION = '0.25.1'

function buildUniverSnapshot(snapshot: OfficeWorkbookSnapshot | undefined, language: string): IWorkbookData {
  const currentLocale = language === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US
  if (!snapshot) {
    return {
      id: 'workbook',
      name: '',
      appVersion: UNIVER_APP_VERSION,
      locale: currentLocale,
      styles: {},
      sheetOrder: [],
      sheets: {},
      resources: []
    }
  }
  return {
    id: snapshot.id || 'workbook',
    name: snapshot.name,
    appVersion: UNIVER_APP_VERSION,
    locale: currentLocale,
    styles: {},
    sheetOrder: snapshot.sheetOrder,
    sheets: Object.fromEntries(
      Object.entries(snapshot.sheets).map(([sheetId, sheet]) => [
        sheetId,
        {
          ...sheet,
          rowData: {},
          columnData: {},
          tabColor: '',
          zoomRatio: 1,
          scrollTop: 0,
          scrollLeft: 0,
          defaultColumnWidth: 88,
          defaultRowHeight: 24,
          freeze: { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 },
          rowHeader: { width: 46, hidden: 0 },
          columnHeader: { height: 20, hidden: 0 },
          showGridlines: 1,
          rightToLeft: 0
        }
      ])
    ),
    resources: []
  }
}

/**
 * In-app office panel: a Univer sheets editor plus a plain toolbar. Files are
 * opened/saved exclusively through Main-minted one-shot FileGrants (native
 * dialogs, or the extension open_panel flow which arrives via route state) —
 * this page never sees a filesystem path.
 *
 * Univer instances are created per mount and disposed on unmount; React
 * StrictMode's double effect pass is safe because creation/disposal is
 * idempotent per container and passive-open grant consumption is guarded by
 * consumedGrantIds.
 */
interface OfficePageProps {
  embedded?: boolean
  initialGrant?: FileGrant
  initialName?: string
  onClose?: () => void
}

export default function OfficePage({ embedded = false, initialGrant, initialName, onClose }: OfficePageProps) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const containerRef = useRef<HTMLDivElement>(null)
  const univerRef = useRef<{ univer: Univer; univerAPI: FUniver } | null>(null)
  const consumedGrantIds = useRef(new Set<string>())
  const [fileName, setFileName] = useState(initialName ?? '')
  const [dirty, setDirty] = useState(false)
  const [hasData, setHasData] = useState(false)
  const [busy, setBusy] = useState<'open' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<OfficeWorkbookWarning[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const locale = useAppStore((state) => state.language)

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    },
    []
  )

  const flashToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }, [])

  // Univer's renderer measures its root during startup. Keep the root in the
  // normal flex flow and defer creation by one frame so its dimensions are
  // settled even when the route replaces another full-height page.
  useEffect(() => {
    const initialLanguage = useAppStore.getState().language
    let disposed = false
    let instance: { univer: Univer; univerAPI: FUniver } | null = null
    let disposable: { dispose: () => void } | null = null
    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container || disposed) return
      instance = createUniver({
        locale: initialLanguage === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US,
        locales: {
          [LocaleType.ZH_CN]: sheetsZhCN,
          [LocaleType.EN_US]: sheetsEnUS
        },
        presets: [
          UniverSheetsCorePreset({
            container,
            header: false,
            footer: false,
            disableAutoFocus: true
          })
        ]
      })
      univerRef.current = instance
      instance.univerAPI.createWorkbook(buildUniverSnapshot(undefined, initialLanguage))
      // Generic mutation events include Univer's startup bookkeeping. This
      // event is scoped to actual cell-value changes, including paste/edit.
      disposable = instance.univerAPI.addEvent(instance.univerAPI.Event.SheetValueChanged, () => {
        setDirty(true)
        setHasData(true)
      })
    })
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      disposable?.dispose()
      univerRef.current = null
      instance?.univerAPI.dispose()
    }
  }, [])

  /** Replace the current workbook with a snapshot from Main. */
  const loadSnapshot = useCallback((name: string, snapshot: OfficeWorkbookSnapshot) => {
    const api = univerRef.current
    if (!api) return
    const current = api.univerAPI.getActiveWorkbook()
    if (current) api.univerAPI.disposeUnit(current.getId())
    api.univerAPI.createWorkbook(buildUniverSnapshot(snapshot, locale))
    setFileName(name)
    setDirty(false)
    setHasData(snapshotHasData(snapshot))
  }, [locale])

  const openWithGrant = useCallback(
    async (grant: FileGrant) => {
      setBusy('open')
      setError(null)
      try {
        const result = await window.electronAPI.officeRead(grant.id)
        if (!result.ok) {
          setError(result.error)
          return
        }
        loadSnapshot(result.name, result.snapshot)
        setWarnings(result.warnings)
      } catch {
        setError('read-failed')
      } finally {
        setBusy(null)
      }
    },
    [loadSnapshot]
  )

  // Passive open (extension open_panel): App routes here with the Main-minted
  // grant in location.state. Consume it once, then clear the state so a
  // reload doesn't re-open it.
  useEffect(() => {
    const state = location.state as { grant?: FileGrant; name?: string } | null
    const grant = state?.grant ?? initialGrant
    if (!grant || typeof grant.id !== 'string') return
    if (consumedGrantIds.current.has(grant.id)) return
    consumedGrantIds.current.add(grant.id)
    navigate(location.pathname, { replace: true, state: null })
    void openWithGrant(grant)
  }, [location.state, location.pathname, navigate, openWithGrant, initialGrant])

  const openFile = useCallback(async () => {
    setBusy('open')
    setError(null)
    try {
      const picked = await window.electronAPI.officeOpenDialog()
      if (!picked) return
      const result = await window.electronAPI.officeRead(picked.grant.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      loadSnapshot(result.name, result.snapshot)
      setWarnings(result.warnings)
    } catch {
      setError('read-failed')
    } finally {
      setBusy(null)
    }
  }, [loadSnapshot])

  const saveAs = useCallback(async () => {
    const api = univerRef.current
    const workbook: FWorkbook | null = api?.univerAPI.getActiveWorkbook() ?? null
    if (!workbook) return
    setBusy('save')
    setError(null)
    try {
      // The raw Univer snapshot carries styles etc.; reduce it to the shared
      // bounded subset before it crosses IPC (Main revalidates everything).
      const converted = sanitizeOfficeSnapshot(workbook.save())
      if (!converted) {
        setError('invalid-snapshot')
        return
      }
      const base = fileName.replace(/\.(xlsx|xls|csv)$/i, '') || 'workbook'
      const picked = await window.electronAPI.officeSaveDialog(`${base}.xlsx`)
      if (!picked) return
      const result = await window.electronAPI.officeSave(picked.grant.id, converted.snapshot)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setFileName(picked.name)
      setDirty(false)
    } catch {
      setError('write-failed')
    } finally {
      setBusy(null)
    }
  }, [fileName])

  const closePanel = () => {
    if (onClose) {
      onClose()
      return
    }
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
  }

  /** Send a bounded, reviewable workbook summary into the composer. */
  const askAgentAboutWorkbook = () => {
    const workbook = univerRef.current?.univerAPI.getActiveWorkbook()
    if (!workbook) return
    const prompt = buildOfficeChatPrompt(workbook.save(), { name: fileName, language: locale })
    if (!prompt) return
    const store = useAppStore.getState()
    const existing = store.currentSessionId ? store.composerDrafts[store.currentSessionId]?.text.trim() : ''
    // Preserve an unsent draft instead of replacing it (same pattern as the
    // boards page): the summary is clearly separated so the person can edit
    // either part before sending.
    store.setComposerPrefill(existing ? `${existing}\n\n${prompt}` : prompt)
    flashToast(t('office.contextReady'))
    navigate('/')
  }

  const iconButton =
    'shrink-0 rounded-md p-1.5 text-cream-dim transition-colors hover:bg-overlay hover:text-cream disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cream-dim'

  const errorKey = error as
    | 'invalid-grant'
    | 'invalid-path'
    | 'file-too-large'
    | 'read-failed'
    | 'parse-failed'
    | 'invalid-snapshot'
    | 'snapshot-too-large'
    | 'write-failed'
    | null

  return (
    <div className={`flex h-full min-h-0 w-full flex-col overflow-hidden bg-ink-950 ${embedded ? 'min-w-0' : ''}`}>
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <button className={iconButton} disabled={busy !== null} onClick={() => void openFile()} title={t('office.open')}>
          {busy === 'open' ? <Loader2 size={15} className="animate-spin" /> : <FolderOpen size={15} />}
        </button>
        <button className={iconButton} disabled={busy !== null} onClick={() => void saveAs()} title={t('office.saveAs')}>
          {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
        </button>
        <button
          className={iconButton}
          disabled={busy !== null}
          onClick={askAgentAboutWorkbook}
          title={t('office.askAgent')}
        >
          <MessageSquareText size={15} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-[13px] text-cream">
          <FileSpreadsheet size={14} className="shrink-0 text-cream-faint" />
          <span className="truncate">{fileName || t('office.untitled')}</span>
          {dirty && <span className="shrink-0 text-cream-faint">· {t('office.unsaved')}</span>}
        </div>
        {warnings.length > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 text-xs text-yellow-600 dark:text-yellow-300"
            title={t('office.openWarnings', { count: warnings.length })}
          >
            <AlertTriangle size={13} />
            {warnings.length}
          </span>
        )}
        {errorKey && (
          <span className="shrink-0 text-xs text-red-500 dark:text-red-300">
            {t(`office.error.${errorKey}`)}
          </span>
        )}
        <button className={iconButton} onClick={closePanel} title={t('office.close')}>
          <X size={15} />
        </button>
      </div>
      {/* Univer mounts into this container; it owns everything inside it. */}
      <div className="relative h-full min-h-0 w-full flex-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
            <FileSpreadsheet size={28} className="text-cream-faint" />
            <p className="text-[13px] text-cream-dim">{t('office.emptyHint')}</p>
            <button
              className="pointer-events-auto mt-1 flex items-center gap-1.5 rounded-full bg-cream px-4 py-2 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void openFile()}
            >
              {busy === 'open' ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
              {t('office.open')}
            </button>
          </div>
        )}
        {toast && (
          <div className="fade-in pointer-events-none absolute left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-ink-900 px-3 py-1.5 shadow-pop">
            <span className="text-[12px] text-cream">{toast}</span>
          </div>
        )}
      </div>
    </div>
  )
}
