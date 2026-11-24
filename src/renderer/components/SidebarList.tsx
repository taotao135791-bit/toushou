import { useEffect, useRef, useState, type ReactNode } from 'react'

const pageSize = 64

/** Grow a list near the viewport edge, sharing the sidebar's outer scroll area. */
export default function SidebarList<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const [limit, setLimit] = useState(pageSize)
  const sentinel = useRef<HTMLDivElement>(null)
  const hasMore = items.length > limit
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setLimit(previous => previous + pageSize)
    }, { root: el.closest('[data-sidebar-scroll]'), rootMargin: '240px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, limit])
  return <>{items.slice(0, limit).map(render)}{hasMore && <div ref={sentinel} className="h-px" aria-hidden="true" />}</>
}
