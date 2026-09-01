import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, FileSpreadsheet, FolderOpen, Loader2, Save, X } from 'lucide-react'
import { CommandType, LocaleType, createUniver } from '@univerjs/presets'
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
import { useAppStore } from '../store'
import { useT } from '../i18n'

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
export default function OfficePage() {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const containerRef = useRef<HTMLDivElement>(null)
  const univerRef = useRef<{ univer: Univer; univerAPI: FUniver } | null>(null)
  const consumedGrantIds = useRef(new Set<string>())
  const [fileName, setFileName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'open' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<OfficeWorkbookWarning[]>([])

  // Mount-only: build the Univer instance (locale follows the app language)
  // with one empty workbook, and track edits as a dirty flag.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const language = useAppStore.getState().language
    const { univer, univerAPI } = createUniver({
      locale: language === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US,
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
    univerRef.current = { univer, univerAPI }
    univerAPI.createWorkbook({})
    const disposable = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      if (event.type === CommandType.MUTATION) setDirty(true)
    })
    return () => {
      disposable.dispose()
      univerRef.current = null
      univer.dispose()
    }
  }, [])

  /** Replace the current workbook with a snapshot from Main. */
  const loadSnapshot = useCallback((name: string, snapshot: OfficeWorkbookSnapshot) => {
    const api = univerRef.current
    if (!api) return
    const current = api.univerAPI.getActiveWorkbook()
    if (current) api.univerAPI.disposeUnit(current.getId())
    api.univerAPI.createWorkbook(snapshot as unknown as Partial<IWorkbookData>)
    setFileName(name)
    setDirty(false)
  }, [])

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
    const grant = state?.grant
    if (!grant || typeof grant.id !== 'string') return
    if (consumedGrantIds.current.has(grant.id)) return
    consumedGrantIds.current.add(grant.id)
    navigate(location.pathname, { replace: true, state: null })
    void openWithGrant(grant)
  }, [location.state, location.pathname, navigate, openWithGrant])

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
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
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
    <div className="flex h-full min-h-0 flex-col bg-ink-950">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <button className={iconButton} disabled={busy !== null} onClick={() => void openFile()} title={t('office.open')}>
          {busy === 'open' ? <Loader2 size={15} className="animate-spin" /> : <FolderOpen size={15} />}
        </button>
        <button className={iconButton} disabled={busy !== null} onClick={() => void saveAs()} title={t('office.saveAs')}>
          {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
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
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  )
}
