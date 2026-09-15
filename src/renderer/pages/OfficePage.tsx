import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, FolderOpen, Loader2, MessageSquareText, Save, X } from 'lucide-react'
import type { FUniver, IWorkbookData, Univer } from '@univerjs/presets'
import type { FWorkbook } from '@univerjs/preset-sheets-core'
import { FileGrant, OfficeEditCell } from '@shared/types'
import {
  OfficeWorkbookSnapshot,
  OfficeWorkbookWarning,
  sanitizeOfficeSnapshot
} from '@shared/officeWorkbook'
import { buildOfficeChatPrompt, snapshotHasData } from '@shared/officeChat'
import { a1ToIndices } from '@shared/officeEdit'
import { useAppStore } from '../store'
import { I18nKey, useT } from '../i18n'

const UNIVER_APP_VERSION = '0.25.1'

// Univer is several MB of JS+CSS, so it loads on first Office open instead
// of with the app. The dynamic imports are cached at module level: revisits
// (and the WorkspacePanel embed) reuse the same promise.
type UniverBundles = {
  presets: typeof import('@univerjs/presets')
  sheetsCore: typeof import('@univerjs/preset-sheets-core')
  sheetsZhCN: (typeof import('@univerjs/preset-sheets-core/locales/zh-CN'))['default']
  sheetsEnUS: (typeof import('@univerjs/preset-sheets-core/locales/en-US'))['default']
}

let univerBundlesPromise: Promise<UniverBundles> | null = null

function loadUniverBundles(): Promise<UniverBundles> {
  if (!univerBundlesPromise) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const bundleLoad = Promise.all([
      import('@univerjs/presets'),
      import('@univerjs/preset-sheets-core'),
      import('@univerjs/preset-sheets-core/locales/zh-CN'),
      import('@univerjs/preset-sheets-core/locales/en-US'),
      // Side-effect CSS rides along so the sheet never paints unstyled.
      import('@univerjs/preset-sheets-core/lib/index.css')
    ]).then(([presets, sheetsCore, zhCN, enUS]) => ({
      presets,
      sheetsCore,
      sheetsZhCN: zhCN.default,
      sheetsEnUS: enUS.default
    }))
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('office-engine-timeout')), 30_000)
    })
    univerBundlesPromise = Promise.race([bundleLoad, timeout]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId)
    })
    // A cached REJECTED promise would keep the loading overlay up forever with
    // no way to retry — drop it so the next open tries again.
    univerBundlesPromise.catch(() => {
      univerBundlesPromise = null
    })
  }
  return univerBundlesPromise
}

type LocaleEnum = UniverBundles['presets']['LocaleType']

function buildUniverSnapshot(
  snapshot: OfficeWorkbookSnapshot | undefined,
  language: string,
  localeEnum: LocaleEnum
): IWorkbookData {
  const currentLocale = language === 'zh' ? localeEnum.ZH_CN : localeEnum.EN_US
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
  const styles: Record<string, unknown> = {}
  const styleIds = new Map<string, string>()
  const toUniverStyle = (style: NonNullable<OfficeWorkbookSnapshot['sheets'][string]['cellData'][number][number]['style']>) => ({
    ...(style.bold ? { bl: 1 } : {}),
    ...(style.italic ? { it: 1 } : {}),
    ...(style.fontSize ? { fs: style.fontSize } : {}),
    ...(style.fontColor ? { fc: style.fontColor } : {}),
    ...(style.fillColor ? { bg: { rgb: style.fillColor } } : {}),
    ...(style.horizontalAlign ? { ht: style.horizontalAlign === 'left' ? 1 : style.horizontalAlign === 'center' ? 2 : style.horizontalAlign === 'right' ? 3 : 4 } : {}),
    ...(style.numberFormat ? { n: style.numberFormat } : {})
  })
  const mapCellData = (cellData: OfficeWorkbookSnapshot['sheets'][string]['cellData']) => Object.fromEntries(
    Object.entries(cellData).map(([row, columns]) => [row, Object.fromEntries(
      Object.entries(columns).map(([column, cell]) => {
        const formulaCell = cell.f ? { ...cell, f: `=${cell.f}` } : cell
        if (!cell.style) return [column, formulaCell]
        const key = JSON.stringify(cell.style)
        let styleId = styleIds.get(key)
        if (!styleId) {
          styleId = `office-style-${styleIds.size + 1}`
          styleIds.set(key, styleId)
          styles[styleId] = toUniverStyle(cell.style)
        }
        return [column, { ...formulaCell, s: styleId }]
      })
    )])
  )
  return {
    id: snapshot.id || 'workbook',
    name: snapshot.name,
    appVersion: UNIVER_APP_VERSION,
    locale: currentLocale,
    styles: styles as IWorkbookData['styles'],
    sheetOrder: snapshot.sheetOrder,
    sheets: Object.fromEntries(
      Object.entries(snapshot.sheets).map(([sheetId, sheet]) => [
        sheetId,
        {
          ...sheet,
          cellData: mapCellData(sheet.cellData),
          rowData: Object.fromEntries(Object.entries(sheet.rowData ?? {}).map(([index, value]) => [index, { ...(value.size !== undefined ? { h: value.size } : {}), ...(value.hidden ? { hd: 1 } : {}) }])),
          columnData: Object.fromEntries(Object.entries(sheet.columnData ?? {}).map(([index, value]) => [index, { ...(value.size !== undefined ? { w: value.size } : {}), ...(value.hidden ? { hd: 1 } : {}) }])),
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
 * Univer is the editing projection, not the source-of-truth file model. When
 * its save snapshot omits a supported style/formula field, carry that field
 * forward from the last loaded/saved baseline. Cleared cells are not
 * resurrected because only cells still present in the current projection are
 * merged.
 */
function mergeOfficeFidelity(
  baseline: OfficeWorkbookSnapshot | null,
  current: OfficeWorkbookSnapshot
): OfficeWorkbookSnapshot {
  if (!baseline) return current
  const sheets = { ...current.sheets }
  for (const [sheetId, sheet] of Object.entries(current.sheets)) {
    const baseSheet = baseline.sheets[sheetId]
    if (!baseSheet) continue
    const cellData = { ...sheet.cellData }
    for (const [row, columns] of Object.entries(sheet.cellData)) {
      const baseColumns = baseSheet.cellData[Number(row)]
      if (!baseColumns) continue
      const mergedColumns = { ...columns }
      for (const [column, cell] of Object.entries(columns)) {
        const baseCell = baseColumns[Number(column)]
        if (!baseCell) continue
        const sameValue = JSON.stringify(cell.v) === JSON.stringify(baseCell.v)
        mergedColumns[Number(column)] = {
          ...cell,
          ...(baseCell.style && !cell.style ? { style: baseCell.style } : {}),
          ...(baseCell.w && !cell.w ? { w: baseCell.w } : {}),
          ...(baseCell.f && !cell.f && sameValue ? { f: baseCell.f } : {})
        }
      }
      cellData[Number(row)] = mergedColumns
    }
    sheets[sheetId] = {
      ...sheet,
      cellData,
      ...(sheet.columnData ? {} : baseSheet.columnData ? { columnData: baseSheet.columnData } : {}),
      ...(sheet.rowData ? {} : baseSheet.rowData ? { rowData: baseSheet.rowData } : {})
    }
  }
  return { ...current, sheets }
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

/** One chat-proposed edit that could not be applied to the open workbook. */
interface EditFailure {
  edit: OfficeEditCell
  reason: 'sheet-missing' | 'out-of-bounds' | 'write-failed' | 'revision-conflict'
}

/** Result of the last confirm-bar apply, kept visible until dismissed. */
interface EditApplyResult {
  applied: number
  failures: EditFailure[]
}

const EDIT_FAILURE_REASON_KEY: Record<EditFailure['reason'], I18nKey> = {
  'sheet-missing': 'office.edit.reasonSheetMissing',
  'out-of-bounds': 'office.edit.reasonOutOfBounds',
  'write-failed': 'office.edit.reasonWriteFailed',
  'revision-conflict': 'office.edit.reasonRevisionConflict'
}

export default function OfficePage({ embedded = false, initialGrant, initialName, onClose }: OfficePageProps) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const containerRef = useRef<HTMLDivElement>(null)
  const univerRef = useRef<{ univer: Univer; univerAPI: FUniver } | null>(null)
  const bundlesRef = useRef<UniverBundles | null>(null)
  const consumedGrantIds = useRef(new Set<string>())
  const baselineSnapshotRef = useRef<OfficeWorkbookSnapshot | null>(null)
  const [engineReady, setEngineReady] = useState(false)
  const [bundleError, setBundleError] = useState(false)
  const [bundleRetryNonce, setBundleRetryNonce] = useState(0)
  const [fileName, setFileName] = useState(initialName ?? '')
  const [dirty, setDirty] = useState(false)
  const revisionRef = useRef(0)
  const [revision, setRevision] = useState(0)
  const openRequestGeneration = useRef(0)
  const pendingSnapshot = useRef<{ name: string; snapshot: OfficeWorkbookSnapshot } | null>(null)
  const [hasData, setHasData] = useState(false)
  const [busy, setBusy] = useState<'open' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<OfficeWorkbookWarning[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [editResult, setEditResult] = useState<EditApplyResult | null>(null)

  const locale = useAppStore((state) => state.language)
  // Chat → panel handoff: a proposal the person applied in chat, waiting for
  // THIS panel's confirm bar. Presence in the store is the pending state.
  const officeEditHandoff = useAppStore((state) => state.officeEditHandoff)
  const setOfficeEditHandoff = useAppStore((state) => state.setOfficeEditHandoff)

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
      // The chat gates its Apply button on this flag; never leak a stale
      // "workbook open" signal after the panel goes away.
      useAppStore.getState().setOfficeWorkbookOpen(false)
      useAppStore.getState().setOfficeWorkbookDirty(false)
      useAppStore.getState().setOfficeWorkbookSnapshot(null)
      useAppStore.getState().setOfficeWorkbookRevision(0)
    },
    []
  )

  // Electron can close the window without routing through the panel's own
  // close button. Keep the native beforeunload guard in place for dirty
  // workbooks so a quit/reload cannot silently discard edits.
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = t('office.discardConfirm')
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, t])

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
      void (async () => {
        const container = containerRef.current
        if (!container || disposed) return
        let bundles: UniverBundles
        try {
          bundles = await loadUniverBundles()
        } catch {
          if (!disposed) setBundleError(true)
          return
        }
        if (disposed || !containerRef.current) return
        bundlesRef.current = bundles
        try {
          const { createUniver, LocaleType } = bundles.presets
          const created = createUniver({
            locale: initialLanguage === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US,
            locales: {
              [LocaleType.ZH_CN]: bundles.sheetsZhCN,
              [LocaleType.EN_US]: bundles.sheetsEnUS
            },
            presets: [
              bundles.sheetsCore.UniverSheetsCorePreset({
                container,
                header: false,
                footer: false,
                disableAutoFocus: true
              })
            ]
          })
          instance = created
          univerRef.current = created
          created.univerAPI.createWorkbook(buildUniverSnapshot(undefined, initialLanguage, LocaleType))
          setEngineReady(true)
          // Generic mutation events include Univer's startup bookkeeping. This
          // event is scoped to actual cell-value changes, including paste/edit.
          disposable = created.univerAPI.addEvent(created.univerAPI.Event.SheetValueChanged, () => {
            setDirty(true)
            useAppStore.getState().setOfficeWorkbookDirty(true)
            setHasData(true)
            revisionRef.current += 1
            setRevision(revisionRef.current)
            const active = created.univerAPI.getActiveWorkbook()
            const converted = active ? sanitizeOfficeSnapshot(active.save()) : null
            if (converted) useAppStore.getState().setOfficeWorkbookSnapshot(converted.snapshot)
            useAppStore.getState().setOfficeWorkbookRevision(revisionRef.current)
          })
        } catch {
          instance?.univerAPI.dispose()
          instance = null
          univerRef.current = null
          if (!disposed) setBundleError(true)
        }
      })()
    })
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      disposable?.dispose()
      univerRef.current = null
      instance?.univerAPI.dispose()
    }
  }, [bundleRetryNonce])

  /** Replace the current workbook with a snapshot from Main. */
  const loadSnapshot = useCallback((name: string, snapshot: OfficeWorkbookSnapshot) => {
    const api = univerRef.current
    const bundles = bundlesRef.current
    if (!api || !bundles) {
      // A passive open can arrive before the several-megabyte Univer bundle
      // finishes loading. Keep the already-authorized snapshot until the
      // editor handshake completes instead of consuming it into a void.
      pendingSnapshot.current = { name, snapshot }
      return
    }
    // A file open is a new document identity even when the shared file
    // adapter uses the generic workbook id. This prevents a staged chat edit
    // from being applied to a different file opened in the same panel.
    const documentSnapshot: OfficeWorkbookSnapshot = {
      ...snapshot,
      id: `document-${crypto.randomUUID()}`
    }
    const current = api.univerAPI.getActiveWorkbook()
    if (current) api.univerAPI.disposeUnit(current.getId())
    api.univerAPI.createWorkbook(buildUniverSnapshot(documentSnapshot, locale, bundles.presets.LocaleType))
    baselineSnapshotRef.current = documentSnapshot
    revisionRef.current = 0
    setRevision(0)
    setFileName(name)
    setDirty(false)
    useAppStore.getState().setOfficeWorkbookDirty(false)
    setHasData(snapshotHasData(documentSnapshot))
    useAppStore.getState().setOfficeWorkbookOpen(true)
    useAppStore.getState().setOfficeWorkbookSnapshot(documentSnapshot)
    useAppStore.getState().setOfficeWorkbookRevision(0)
  }, [locale])

  useEffect(() => {
    if (!engineReady || !pendingSnapshot.current) return
    const next = pendingSnapshot.current
    pendingSnapshot.current = null
    loadSnapshot(next.name, next.snapshot)
  }, [engineReady, loadSnapshot])

  const openWithGrant = useCallback(
    async (grant: FileGrant) => {
      const requestGeneration = ++openRequestGeneration.current
      setBusy('open')
      setError(null)
      try {
        if (dirty) {
          setError('unsaved-changes')
          return
        }
        const result = await window.electronAPI.officeRead(grant.id)
        if (requestGeneration !== openRequestGeneration.current) return
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
    [dirty, loadSnapshot]
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
    if (dirty && !window.confirm(t('office.discardConfirm'))) return
    const requestGeneration = ++openRequestGeneration.current
    setBusy('open')
    setError(null)
    try {
      const picked = await window.electronAPI.officeOpenDialog()
      if (!picked) return
      const result = await window.electronAPI.officeRead(picked.grant.id)
      if (requestGeneration !== openRequestGeneration.current) return
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
  }, [dirty, loadSnapshot, t])

  const saveAs = useCallback(async () => {
    const api = univerRef.current
    const workbook: FWorkbook | null = api?.univerAPI.getActiveWorkbook() ?? null
    if (!workbook) return
    const revisionAtCapture = revisionRef.current
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
      const fidelitySnapshot = mergeOfficeFidelity(baselineSnapshotRef.current, converted.snapshot)
      const base = fileName.replace(/\.(xlsx|xls|csv)$/i, '') || 'workbook'
      const picked = await window.electronAPI.officeSaveDialog(`${base}.xlsx`)
      if (!picked) return
      const result = await window.electronAPI.officeSave(picked.grant.id, fidelitySnapshot)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setFileName(picked.name)
      baselineSnapshotRef.current = fidelitySnapshot
      useAppStore.getState().setOfficeWorkbookSnapshot(fidelitySnapshot)
      if (revisionRef.current === revisionAtCapture) {
        setDirty(false)
        useAppStore.getState().setOfficeWorkbookDirty(false)
      } else {
        // Edits made while the native dialog or disk write was in flight are
        // newer than the saved revision and must remain visibly dirty.
        setDirty(true)
        useAppStore.getState().setOfficeWorkbookDirty(true)
        flashToast(t('office.saveKeptChanges'))
      }
    } catch {
      setError('write-failed')
    } finally {
      setBusy(null)
    }
  }, [fileName, flashToast, t])

  const closePanel = () => {
    if (dirty && !window.confirm(t('office.discardConfirm'))) return
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
    const prompt = buildOfficeChatPrompt(workbook.save(), { name: fileName, language: locale, includeDataSample: true })
    if (!prompt) return
    const store = useAppStore.getState()
    // Preserve the current conversation: workbook context is a user-authored
    // draft addition, not an implicit new-chat action.
    store.setComposerPrefill(prompt)
    flashToast(t('office.contextReady'))
    navigate('/')
  }

  /**
   * Confirm-bar Apply: write each chat-proposed edit into the in-memory
   * Univer workbook. This is the ONLY place agent-suggested values enter the
   * sheet, and it is renderer-local: nothing is persisted here — the change
   * becomes a file only through the user's own save-as flow. Sheets are
   * looked up by exact name, cells are bounds-checked against the sheet
   * grid, and values are parser-guaranteed plain scalars (never formulas).
   */
  const applyOfficeEditHandoff = useCallback(() => {
    const handoff = useAppStore.getState().officeEditHandoff
    if (!handoff) return
    const workbook = univerRef.current?.univerAPI.getActiveWorkbook()
    if (!workbook) {
      // Nothing to land on — keep the proposal staged so the person can open
      // a workbook and confirm again.
      flashToast(t('office.edit.noWorkbook'))
      return
    }
    const currentIdentity = useAppStore.getState()
    if (
      (handoff.documentId && currentIdentity.officeWorkbookSnapshot?.id !== handoff.documentId) ||
      (handoff.baseRevision !== undefined && currentIdentity.officeWorkbookRevision !== handoff.baseRevision)
    ) {
      const failures = handoff.edits.map((edit) => ({ edit, reason: 'revision-conflict' as const }))
      setEditResult({ applied: 0, failures })
      setOfficeEditHandoff(null)
      flashToast(t('office.edit.conflictToast'))
      return
    }
    const failures: EditFailure[] = []
    const validEdits: Array<{ edit: OfficeEditCell; sheet: NonNullable<ReturnType<FWorkbook['getSheetByName']>>; row: number; column: number }> = []
    for (const edit of handoff.edits) {
      const sheet = workbook.getSheetByName(edit.sheet)
      if (!sheet) {
        failures.push({ edit, reason: 'sheet-missing' })
        continue
      }
      const position = a1ToIndices(edit.cell)
      if (!position || position.row >= sheet.getMaxRows() || position.column >= sheet.getMaxColumns()) {
        failures.push({ edit, reason: 'out-of-bounds' })
        continue
      }
      validEdits.push({ edit, sheet, row: position.row, column: position.column })
    }
    // Known validation failures do not partially mutate the workbook. The
    // batch stays reviewable and can be regenerated against the current doc.
    if (failures.length > 0) {
      setEditResult({ applied: 0, failures })
      setOfficeEditHandoff(null)
      flashToast(t('office.edit.partialToast', { applied: 0, failed: failures.length }))
      return
    }
    let applied = 0
    for (const { edit, sheet, row, column } of validEdits) {
      try {
        sheet.getRange(row, column).setValue(edit.value)
        applied += 1
      } catch {
        failures.push({ edit, reason: 'write-failed' })
      }
    }
    setEditResult({ applied, failures })
    setOfficeEditHandoff(null)
    flashToast(
      failures.length === 0
        ? t('office.edit.appliedToast', { count: applied })
        : t('office.edit.partialToast', { applied, failed: failures.length })
    )
  }, [flashToast, setOfficeEditHandoff, t])

  const dismissOfficeEditHandoff = useCallback(() => {
    setOfficeEditHandoff(null)
  }, [setOfficeEditHandoff])

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
    | 'unsaved-changes'
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
          <span className="shrink-0 text-[11px] text-cream-faint" title="Document revision">v{revision}</span>
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
      {/* Chat handoff: confirm bar while a proposal is pending, apply result after. */}
      {(officeEditHandoff || editResult) && (
        <div className="shrink-0 space-y-1.5 border-b border-line bg-overlay px-3 py-2">
          {officeEditHandoff && (
            <div className="flex flex-wrap items-center gap-2">
              <FileSpreadsheet size={13} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 text-[12px] text-cream">
                {t('office.edit.confirmBar', { count: officeEditHandoff.edits.length })}
                {officeEditHandoff.note && (
                  <span className="ml-1.5 text-[11px] text-cream-faint">{officeEditHandoff.note}</span>
                )}
              </span>
              <button
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-cream-faint transition hover:bg-overlay-strong hover:text-cream"
                onClick={dismissOfficeEditHandoff}
              >
                {t('office.edit.panelIgnore')}
              </button>
              <button
                className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-ink-950 transition hover:opacity-90"
                onClick={applyOfficeEditHandoff}
              >
                {t('office.edit.panelApply')}
              </button>
            </div>
          )}
          {editResult && (
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                {editResult.failures.length === 0 ? (
                  <p className="flex items-center gap-1.5 text-[12px] text-green-500 dark:text-green-400">
                    <CheckCircle2 size={12} className="shrink-0" />
                    {t('office.edit.appliedToast', { count: editResult.applied })}
                  </p>
                ) : (
                  <>
                    <p className="flex items-center gap-1.5 text-[12px] text-amber-500 dark:text-amber-400">
                      <AlertTriangle size={12} className="shrink-0" />
                      {t('office.edit.partialSummary', { applied: editResult.applied, failed: editResult.failures.length })}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {editResult.failures.map(({ edit, reason }, index) => (
                        <li key={index} className="text-[11px] text-cream-faint">
                          <span className="font-mono">
                            {edit.sheet}!{edit.cell}
                          </span>
                          {' · '}
                          {t(EDIT_FAILURE_REASON_KEY[reason])}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <button
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-cream-faint transition hover:bg-overlay-strong hover:text-cream"
                onClick={() => setEditResult(null)}
              >
                {t('office.edit.panelDismiss')}
              </button>
            </div>
          )}
        </div>
      )}
      {/* Univer mounts into this container; it owns everything inside it. */}
      <div className="relative h-full min-h-0 w-full flex-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
        {!engineReady && bundleError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-cream-faint">
            <span className="text-[13px]">{t('office.loadFailed')}</span>
            <button
              onClick={() => {
                setBundleError(false)
                setBundleRetryNonce((n) => n + 1)
              }}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:text-cream"
            >
              {t('office.retry')}
            </button>
          </div>
        )}
        {!engineReady && !bundleError && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 text-cream-faint">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-[13px]">{t('app.loading')}</span>
          </div>
        )}
        {engineReady && !hasData && (
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
