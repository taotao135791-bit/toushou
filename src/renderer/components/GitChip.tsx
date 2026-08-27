import type { ReactNode } from 'react'
import { GitBranch } from 'lucide-react'
import { useAppStore } from '../store'
import { useGitInfo } from '../lib/useGitInfo'

/** Header chip: current branch + worktree +/- totals; opens the changes tab. */
export default function GitChip({ trailing }: { trailing?: ReactNode }) {
  const { info } = useGitInfo()
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen)
  const setActiveRightTab = useAppStore((s) => s.setActiveRightTab)

  if (!info) return null

  return (
    <>
      <button
        onClick={() => {
          setRightPanelOpen(true)
          setActiveRightTab('changes')
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
    </>
  )
}
