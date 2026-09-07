import { useAppStore } from '../store'
import Sidebar from './Sidebar'
import UpdateBanner from './UpdateBanner'
import WorkspacePanel from './WorkspacePanel'
import { useLocation } from 'react-router-dom'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const workspacePanel = useAppStore((state) => state.workspacePanel)
  const location = useLocation()
  // /browser and /office are the full-page forms of the same Main-owned
  // surfaces (one panel per window) — showing both would double-mount them.
  // On every other route the panel persists so an agent-driven task keeps
  // its live surface while the user visits 看板 or 设置.
  const panelKind = workspacePanel?.kind
  const routeOwnsSurface =
    (location.pathname === '/browser' && panelKind === 'browser') ||
    (location.pathname === '/office' && panelKind === 'office')

  return (
    <div className="flex h-full w-full overflow-hidden bg-ink-950 text-cream">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <UpdateBanner />
        {children}
      </main>
      {workspacePanel && !routeOwnsSurface ? <WorkspacePanel panel={workspacePanel} /> : null}
    </div>
  )
}
