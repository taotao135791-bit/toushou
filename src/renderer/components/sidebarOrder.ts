import { useEffect, useRef, useState, type DragEvent, type MutableRefObject } from 'react'

type OrderSetting = 'sidebarProjectOrder' | 'sidebarSessionOrder'

export function useSidebarOrder(setting: OrderSetting) {
  const [order, setOrder] = useState<string[]>([])
  const changed = useRef(false)
  useEffect(() => {
    let mounted = true
    void window.electronAPI.getStore(setting).then(saved => {
      if (mounted && !changed.current && Array.isArray(saved)) setOrder(saved.filter(key => typeof key === 'string'))
    }).catch(() => {})
    return () => { mounted = false }
  }, [setting])
  return [order, (next: string[]) => {
    changed.current = true
    setOrder(next)
    void window.electronAPI.setStore(setting, next)
  }] as const
}

/** Preserve the ordering of hidden groups (such as archived projects). */
export function moveSidebarRow(visible: string[], saved: string[], source: string, target: string, after: boolean) {
  if (source === target || !visible.includes(source) || !visible.includes(target)) return null
  const next = visible.filter(key => key !== source)
  next.splice(next.indexOf(target) + Number(after), 0, source)
  const present = new Set(visible)
  return next.concat(saved.filter(key => !present.has(key)))
}

export function useSidebarDrag(move: (source: string, target: string, after: boolean) => void, draggedKey?: MutableRefObject<string | null>) {
  const source = useRef<{ key: string; group: string } | null>(null)
  const highlight = useRef<HTMLElement | null>(null)
  const clear = () => {
    highlight.current?.removeAttribute('data-drop-edge')
    highlight.current = null
  }
  return (key: string, group: string) => {
    const allowed = () => source.current?.group === group && source.current.key !== key && (!draggedKey || draggedKey.current === source.current.key)
    const isAfter = (e: DragEvent<HTMLElement>) => {
      const bounds = e.currentTarget.getBoundingClientRect()
      return e.clientY >= bounds.top + bounds.height / 2
    }
    return {
      draggable: true,
      onDragStart(e: DragEvent<HTMLElement>) {
        source.current = { key, group }
        if (draggedKey) draggedKey.current = key
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('application/x-toushou-sidebar-row', 'move')
      },
      onDragOver(e: DragEvent<HTMLElement>) {
        if (!allowed()) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (highlight.current !== e.currentTarget) clear()
        highlight.current = e.currentTarget
        e.currentTarget.dataset.dropEdge = isAfter(e) ? 'after' : 'before'
      },
      onDragLeave(e: DragEvent<HTMLElement>) {
        if (highlight.current === e.currentTarget && !e.currentTarget.contains(e.relatedTarget as Node | null)) clear()
      },
      onDrop(e: DragEvent<HTMLElement>) {
        if (source.current && allowed()) {
          e.preventDefault()
          move(source.current.key, key, isAfter(e))
        }
        source.current = null
        clear()
      },
      onDragEnd() { source.current = null; if (draggedKey) draggedKey.current = null; clear() }
    }
  }
}
