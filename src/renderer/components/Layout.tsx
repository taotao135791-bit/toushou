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
  const isChat = location.pathname === '/'

  return (
    <div className="flex h-full w-full overflow-hidden bg-ink-950 text-cream">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <UpdateBanner />
        {children}
      </main>
      {isChat && workspacePanel ? <WorkspacePanel panel={workspacePanel} /> : null}
    </div>
  )
}
