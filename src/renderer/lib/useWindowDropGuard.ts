import { useEffect } from 'react'

/**
 * Stray file drops must never navigate the Electron window to a file:// URL —
 * that destroys all renderer state. Cancel file drags at the window in the
 * capture phase, before any element handler runs.
 *
 * The guard only ever calls preventDefault; it never stops propagation, so
 * feature drop zones (composer, packages, boards) keep receiving the very
 * same events. Text-only drags are left untouched so native text drops into
 * editable fields keep working.
 */
export function useWindowDropGuard(): void {
  useEffect(() => {
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onDragOver = (e: DragEvent) => {
      // Allow the drop to fire anywhere; local zones then decide the
      // dropEffect. Where nothing handles the drop, the drop guard below
      // swallows it instead of letting Chromium navigate.
      if (isFileDrag(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault()
    }
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [])
}
