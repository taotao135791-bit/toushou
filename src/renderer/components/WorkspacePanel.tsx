import { useEffect, useState } from 'react'
import { Globe2, Table2, X } from 'lucide-react'
import BrowserPage from '../pages/BrowserPage'
import OfficePage from '../pages/OfficePage'
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
  const [kind, setKind] = useState<WorkspacePanelState['kind']>(panel.kind)

  useEffect(() => setKind(panel.kind), [panel.kind])

  const close = () => setWorkspacePanel(null)
  const openBrowser = () => setWorkspacePanel({ kind: 'browser' })
  const openOffice = () => setWorkspacePanel({ kind: 'office' })

  return (
    <aside
      aria-label={kind === 'browser' ? 'Browser workspace' : 'Office workspace'}
      className="flex w-[min(38vw,560px)] min-w-[320px] shrink-0 flex-col border-l border-line bg-ink-950 shadow-[-12px_0_32px_rgba(0,0,0,0.08)]"
    >
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
          onClick={close}
          aria-label={t('workspace.close')}
          className="ml-auto rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
        >
          <X size={14} />
        </button>
      </div>
      {kind === 'browser' ? (
        <BrowserPage key="browser" embedded initialUrl={panel.kind === 'browser' ? panel.url : undefined} onClose={close} />
      ) : (
        <OfficePage
          key="office"
          embedded
          initialGrant={panel.kind === 'office' ? panel.grant : undefined}
          initialName={panel.kind === 'office' ? panel.name : undefined}
          onClose={close}
        />
      )}
    </aside>
  )
}
