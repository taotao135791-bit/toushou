import { useEffect, useRef, useState } from 'react'
import { GitInfo } from '@shared/types'
import { useAppStore } from '../store'

/**
 * Working-tree change summary for the current workspace.
 * Refetches on: workspace/session switch, current session going working→idle,
 * gitInfoVersion bumps (e.g. after a rollback) and manual refresh().
 * `undefined` = loading, `null` = not a git repository.
 */
export function useGitInfo(): { info: GitInfo | null | undefined; refresh: () => void } {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const isBusy = useAppStore((s) => (s.currentSessionId ? Boolean(s.busy[s.currentSessionId]) : false))
  const gitInfoVersion = useAppStore((s) => s.gitInfoVersion)
  const [info, setInfo] = useState<GitInfo | null | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const prevBusy = useRef(isBusy)

  // working→idle: the agent likely touched files; pull a fresh summary.
  useEffect(() => {
    if (prevBusy.current && !isBusy) setTick((n) => n + 1)
    prevBusy.current = isBusy
  }, [isBusy])

  useEffect(() => {
    if (!currentWorkspace) {
      setInfo(undefined)
      return
    }
    let cancelled = false
    window.electronAPI.gitInfo(currentWorkspace.id).then((result) => {
      if (!cancelled) setInfo(result)
    })
    return () => {
      cancelled = true
    }
  }, [currentWorkspace, currentSessionId, gitInfoVersion, tick])

  return { info, refresh: () => setTick((n) => n + 1) }
}
