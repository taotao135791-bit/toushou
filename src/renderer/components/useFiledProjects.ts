import { useCallback, useEffect, useRef, useState } from 'react'
import type { MoveConversationResult } from '@shared/types'
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
  const move = useCallback((grantId: string, entry: SidebarConversation, projectId: string) => {
    const request = queue.current.then(async (): Promise<MoveConversationResult> => {
      const result = await window.electronAPI.moveSidebarConversation(grantId, entry.key, projectId, entry.kind === 'live' ? entry.session.id : undefined)
      if (result.ok) {
        const keys = [entry.key, JSON.stringify([entry.workspacePath, result.row.uuid]), JSON.stringify([result.row.cwd, result.row.uuid]), ...result.retiredSessionIds.map(id => JSON.stringify([entry.workspacePath, `runtime:${id}`]))]
        setAssignments(current => {
          if (!keys.some(key => Object.hasOwn(current, key))) return current
          const next = { ...current }
          for (const key of keys) delete next[key]
          return next
        })
      }
      return result
    }).catch((): MoveConversationResult => ({ ok: false, error: 'failed' }))
    queue.current = request
    return request
  }, [])
  return { assignments, file, move }
}
