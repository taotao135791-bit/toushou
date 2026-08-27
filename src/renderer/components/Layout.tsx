import { useAppStore } from '../store'
import Sidebar from './Sidebar'
import RightPanel from './RightPanel'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen)

  return (
    <div className="flex h-full w-full overflow-hidden bg-ink-950 text-cream">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      {rightPanelOpen && <RightPanel />}
    </div>
  )
}
