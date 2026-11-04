import { useCallback, useLayoutEffect, useRef, useState } from 'react'

interface ReadingPosition { top: number; pinned: boolean; anchor?: { id: string; kind: 'message' | 'turn'; offset: number } }
// UI memory only. Never persists transcript content or writes application data.
const positions = new Map<string, ReadingPosition>()
const MAX_POSITIONS = 100
function remember(key: string, position: ReadingPosition) {
  positions.delete(key)
  positions.set(key, position)
  if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value!)
}

export function useTranscriptScroll(sessionId: string | null) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const restoringRef = useRef<ReadingPosition | null>(null)
  const appliedTopRef = useRef<number | null>(null)
  const captureFrameRef = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const key = sessionId ?? '__new-conversation__'

  const capture = useCallback((): ReadingPosition | null => {
    const viewport = viewportRef.current
    if (!viewport) return null
    const position: ReadingPosition = { top: viewport.scrollTop, pinned: pinnedRef.current }
    if (position.pinned) return position
    const bounds = viewport.getBoundingClientRect()
    // Hit-test a few visible points rather than forcing geometry for every
    // historical row while the user scrolls a long transcript.
    const x = bounds.left + bounds.width / 2
    for (const offset of [12, 48, 96]) {
      const y = Math.min(bounds.bottom - 1, bounds.top + offset)
      const hit = document.elementsFromPoint(x, y).find(element => viewport.contains(element))
      const element = hit?.closest<HTMLElement>('[data-message-id]') ?? hit?.closest<HTMLElement>('[data-chat-turn]')
      if (!element) continue
      const kind = element.dataset.messageId ? 'message' : 'turn'
      const id = element.dataset.messageId ?? element.dataset.chatTurn
      if (id) position.anchor = { id, kind, offset: element.getBoundingClientRect().top - bounds.top }
      if (position.anchor) break
    }
    return position
  }, [])

  const applyPosition = useCallback((position: ReadingPosition): boolean => {
    const viewport = viewportRef.current
    if (!viewport) return false
    let top = position.pinned ? viewport.scrollHeight : position.top
    let anchorFound = !position.anchor
    if (!position.pinned && position.anchor) {
      const { anchor } = position
      const attribute = anchor.kind === 'message' ? 'data-message-id' : 'data-chat-turn'
      const element = viewport.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(anchor.id)}"]`)
      if (element && element.getClientRects().length > 0) {
        anchorFound = true
        top = viewport.scrollTop + element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset
      }
    }
    viewport.scrollTop = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight))
    appliedTopRef.current = viewport.scrollTop
    return anchorFound
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const saved = positions.get(key) ?? { top: 0, pinned: true }
    pinnedRef.current = saved.pinned
    restoringRef.current = saved
    setShowJump(!saved.pinned)
    if (applyPosition(saved)) restoringRef.current = null
    let frame = 0
    const follow = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const position = restoringRef.current ?? (pinnedRef.current ? { top: 0, pinned: true } : positions.get(key))
        if (position && applyPosition(position)) {
          restoringRef.current = null
          const current = capture()
          if (current) remember(key, current)
        }
      })
    }
    // A user's wheel/touch/key input takes precedence over any deferred
    // history restoration or preview-load adjustment.
    const userInput = () => { restoringRef.current = null; appliedTopRef.current = null }
    viewport.addEventListener('wheel', userInput, { passive: true })
    viewport.addEventListener('touchstart', userInput, { passive: true })
    viewport.addEventListener('pointerdown', userInput)
    viewport.addEventListener('keydown', userInput)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(follow) : null
    observer?.observe(content)
    observer?.observe(viewport)
    window.addEventListener('resize', follow)
    follow()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', follow)
      viewport.removeEventListener('wheel', userInput)
      viewport.removeEventListener('touchstart', userInput)
      viewport.removeEventListener('pointerdown', userInput)
      viewport.removeEventListener('keydown', userInput)
      if (frame) cancelAnimationFrame(frame)
      if (captureFrameRef.current) cancelAnimationFrame(captureFrameRef.current)
      captureFrameRef.current = 0
    }
  }, [key, applyPosition, capture])

  const onScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    if (appliedTopRef.current !== null && Math.abs(viewport.scrollTop - appliedTopRef.current) < 1) {
      appliedTopRef.current = null
      return
    }
    appliedTopRef.current = null
    restoringRef.current = null
    pinnedRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48
    setShowJump(!pinnedRef.current)
    remember(key, { top: viewport.scrollTop, pinned: pinnedRef.current })
    if (!captureFrameRef.current) captureFrameRef.current = requestAnimationFrame(() => {
      captureFrameRef.current = 0
      const current = capture()
      if (current) remember(key, current)
    })
  }, [key, capture])

  const jumpToBottom = useCallback(() => {
    restoringRef.current = null
    pinnedRef.current = true
    applyPosition({ top: 0, pinned: true })
    setShowJump(false)
    const current = capture()
    if (current) remember(key, current)
  }, [key, applyPosition, capture])

  return { viewportRef, contentRef, onScroll, showJump, jumpToBottom }
}
