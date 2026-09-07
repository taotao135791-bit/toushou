import { Folder, GitBranch } from 'lucide-react'
import { useAppStore } from '../store'
import { useGitInfo } from '../lib/useGitInfo'
import { basename } from '../lib/path'
import { useT } from '../i18n'

/**
 * Home-only workspace bar: a dedicated strip NARROWER than the composer
 * card, holding the project and branch chips so the card itself stays a
 * single quiet surface (ChatGPT/Kimi put context in a separate strip too).
 * Renders nothing without a workspace.
 */
export default function WorkspaceStrip() {
  const t = useT()
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const { info: gitInfo } = useGitInfo()
  if (!currentWorkspace) return null
  return (
    <div
      className="rise flex w-[92%] items-center gap-1 rounded-xl bg-overlay/60 px-3 py-2"
      style={{ animationDelay: '120ms' }}
    >
      <div
        title={currentWorkspace.displayPath}
        aria-label={t('composer.currentProject')}
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium whitespace-nowrap text-cream-dim transition-colors hover:bg-overlay"
      >
        <Folder size={12} className="shrink-0 text-accent" />
        <span className="max-w-[180px] truncate">
          {currentWorkspace.source === 'default'
            ? t('sidebar.defaultWorkspace')
            : basename(currentWorkspace.displayPath) || currentWorkspace.displayPath}
        </span>
      </div>
      {currentWorkspace.source !== 'default' && gitInfo && (
        <div
          title={gitInfo.branch}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium whitespace-nowrap text-cream-dim transition-colors hover:bg-overlay"
        >
          <GitBranch size={12} className="shrink-0 text-accent" />
          <span className="max-w-[160px] truncate font-mono">{gitInfo.branch}</span>
        </div>
      )}
    </div>
  )
}
