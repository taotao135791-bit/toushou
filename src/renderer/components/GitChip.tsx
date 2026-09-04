import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { useAppStore } from '../store'
import { useGitInfo } from '../lib/useGitInfo'
import GitTreePopover from './GitTreePopover'

/** Header chip: current branch + worktree +/- totals; opens the changes tab. */
export default function GitChip({ trailing }: { trailing?: ReactNode }) {
  const { info } = useGitInfo()
  const setWorkspacePanel = useAppStore((s) => s.setWorkspacePanel)
  const workspacePanel = useAppStore((s) => s.workspacePanel)
  const [open, setOpen] = useState(false)

  // An agent-opened browser/Office surface owns the right side. Close the
  // Git popover so an automatic task transition never leaves two workspaces
  // competing for the user's attention.
  useEffect(() => {
    if (workspacePanel) setOpen(false)
  }, [workspacePanel])

  if (!info) return null

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((value) => !value)
          setWorkspacePanel(null)
        }}
        title={info.branch}
        className="app-no-drag flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-overlay px-2 py-[3px] text-cream-dim transition hover:border-line-strong hover:text-cream"
      >
        <GitBranch size={11} className="shrink-0" />
        <span className="max-w-[120px] truncate font-mono text-[11px]">{info.branch}</span>
        {(info.totalAdditions > 0 || info.totalDeletions > 0) && (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-emerald-500">+{info.totalAdditions}</span>
            <span className="text-cream-faint">/</span>
            <span className="text-red-500">-{info.totalDeletions}</span>
          </span>
        )}
      </button>
      {trailing}
      {open && <GitTreePopover />}
    </div>
  )
}
