import { useEffect, useRef, useState } from 'react'
import { Blocks, ChevronsLeft, Globe2, Table2, X } from 'lucide-react'
import BrowserPage from '../pages/BrowserPage'
import OfficePage from '../pages/OfficePage'
import ToolsPanel from './ToolsPanel'
import { useT } from '../i18n'
import { WorkspacePanel as WorkspacePanelState, useAppStore } from '../store'

interface WorkspacePanelProps {
  panel: WorkspacePanelState
}

/**
 * Contextual work surface for the active chat. It keeps the conversation in
 * the main column while a browser or workbook is open, matching the side-work
 * pattern users expect from desktop agent apps.
 */
export default function WorkspacePanel({ panel }: WorkspacePanelProps) {
  const t = useT()
  const setWorkspacePanel = useAppStore((state) => state.setWorkspacePanel)
  const officeWorkbookDirty = useAppStore((state) => state.officeWorkbookDirty)
  const [kind, setKind] = useState<WorkspacePanelState['kind']>(panel.kind)
  const [width, setWidth] = useState(() => {
    const raw = window.localStorage.getItem('toushou.workspace.width')
    const stored = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(stored) ? Math.min(Math.max(stored, 320), 720) : 440
  })
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => setKind(panel.kind), [panel.kind])
  useEffect(() => {
    window.localStorage.setItem('toushou.workspace.width', String(width))
  }, [width])

  const close = () => {
    if (kind === 'office' && officeWorkbookDirty && !window.confirm(t('office.discardConfirm'))) return
    setWorkspacePanel(null)
  }
  const changeKind = (next: WorkspacePanelState['kind']) => {
    if (kind === 'office' && next !== 'office' && officeWorkbookDirty && !window.confirm(t('office.discardConfirm'))) return
    setWorkspacePanel({ kind: next })
  }
  const openBrowser = () => changeKind('browser')
  const openOffice = () => changeKind('office')
  const openPlugins = () => changeKind('plugins')
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragState.current = { startX: event.clientX, startWidth: width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return
    setWidth(Math.min(Math.max(dragState.current.startWidth - (event.clientX - dragState.current.startX), 320), 720))
  }
  const endResize = () => {
    dragState.current = null
  }
  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') setWidth((value) => Math.min(value + 24, 720))
    if (event.key === 'ArrowRight') setWidth((value) => Math.max(value - 24, 320))
  }
  const workspaceLabel =
    kind === 'browser' ? 'Browser workspace' : kind === 'office' ? 'Office workspace' : 'Plugin workspace'

  return (
    <aside
      aria-label={workspaceLabel}
      style={{ '--workspace-width': `${width}px` } as React.CSSProperties}
      className="workspace-panel relative flex w-[var(--workspace-width)] min-w-[320px] shrink-0 flex-col border-l border-line bg-ink-950 shadow-[-12px_0_32px_rgba(0,0,0,0.08)] max-[1100px]:absolute max-[1100px]:bottom-0 max-[1100px]:right-0 max-[1100px]:top-0 max-[1100px]:z-30 max-[1100px]:w-[min(92vw,560px)]"
    >
      <div
        role="separator"
        aria-label="Resize workspace"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={720}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={resizeByKeyboard}
        className="group absolute -left-1 top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center focus:outline-none"
      >
        <span className="h-10 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-accent group-focus:bg-accent" />
        <ChevronsLeft size={10} className="pointer-events-none absolute left-0 hidden text-accent group-hover:block" />
      </div>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          onClick={openBrowser}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] ${kind === 'browser' ? 'bg-overlay text-cream' : 'text-cream-faint hover:text-cream'}`}
        >
          <Globe2 size={12} />
          {t('workspace.browser')}
        </button>
        <button
          type="button"
          onClick={openOffice}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] ${kind === 'office' ? 'bg-overlay text-cream' : 'text-cream-faint hover:text-cream'}`}
        >
          <Table2 size={12} />
          {t('workspace.office')}
        </button>
        <button
          type="button"
          onClick={openPlugins}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] ${kind === 'plugins' ? 'bg-overlay text-cream' : 'text-cream-faint hover:text-cream'}`}
        >
          <Blocks size={12} />
          {t('workspace.plugins')}
        </button>
        <button
          type="button"
          onClick={close}
          aria-label={t('workspace.close')}
          className="ml-auto rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
        >
          <X size={14} />
        </button>
      </div>
      {kind === 'browser' ? (
        <BrowserPage embedded initialUrl={panel.kind === 'browser' ? panel.url : undefined} onClose={close} />
      ) : kind === 'office' ? (
        <OfficePage
          embedded
          initialGrant={panel.kind === 'office' ? panel.grant : undefined}
          initialName={panel.kind === 'office' ? panel.name : undefined}
          onClose={close}
        />
      ) : <ToolsPanel />}
    </aside>
  )
}
