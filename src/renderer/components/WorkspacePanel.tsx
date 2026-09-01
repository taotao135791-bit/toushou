import BrowserPage from '../pages/BrowserPage'
import OfficePage from '../pages/OfficePage'
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
  const setWorkspacePanel = useAppStore((state) => state.setWorkspacePanel)
  const close = () => setWorkspacePanel(null)

  return (
    <aside
      aria-label={panel.kind === 'browser' ? 'Browser workspace' : 'Office workspace'}
      className="flex w-[min(38vw,560px)] min-w-[280px] shrink-0 flex-col border-l border-line bg-ink-950 shadow-[-12px_0_32px_rgba(0,0,0,0.08)]"
    >
      {panel.kind === 'browser' ? (
        <BrowserPage embedded initialUrl={panel.url} onClose={close} />
      ) : (
        <OfficePage embedded initialGrant={panel.grant} initialName={panel.name} onClose={close} />
      )}
    </aside>
  )
}
