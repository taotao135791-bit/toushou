import { useCallback, useEffect, useRef, useState } from 'react'
import type { SidebarConversation } from '../lib/sidebarConversations'

export function runtimeFilingKey(entry: SidebarConversation): string | undefined {
  return entry.kind === 'live' ? JSON.stringify([entry.workspacePath, `runtime:${entry.session.id}`]) : undefined
}

export function useFiledProjects() {
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    let active = true
    queue.current = window.electronAPI.getStore('sidebarSessionProjects').then(saved => {
      if (active && saved && typeof saved === 'object' && !Array.isArray(saved)) setAssignments(saved)
    }).catch(() => {})
    return () => { active = false }
  }, [])
  const file = useCallback((key: string, targetId: string | null, previousKey?: string, migrateOnly?: boolean) => {
    const request = queue.current.then(async () => {
      if (!await window.electronAPI.fileSidebarConversation(key, targetId, previousKey, migrateOnly)) return false
      setAssignments(current => {
        const next = { ...current }
        if (previousKey && previousKey !== key) delete next[previousKey]
        if (targetId === null) delete next[key]
        else next[key] = targetId
        return next
      })
      return true
    }).catch(() => false)
    queue.current = request
    return request
  }, [])
  return { assignments, file }
}
