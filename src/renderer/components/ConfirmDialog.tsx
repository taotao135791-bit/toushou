import { useCallback, useRef, useState } from 'react'
import { useModalBoundary } from '../lib/modalBoundary'
import { useT } from '../i18n'

export interface ConfirmDialogRequest {
  /** Dialog heading, already localized by the caller. */
  title: string
  /** Consequence statement, already localized by the caller. */
  body: string
  /** Confirm button label; defaults to the shared 删除/Delete wording. */
  confirmLabel?: string
  /** Destructive actions render the confirm button in red. */
  danger?: boolean
  onConfirm: () => void
}

/**
 * The one centered confirmation dialog for destructive actions (same visual
 * pattern as the Sidebar rename/delete dialogs). Explicit Cancel — button or
 * Escape — always cancels; a stray backdrop click must NOT fire the action,
 * so it only stops propagation.
 *
 * Enter/exit are animated (backdrop fade + panel scale); the exit runs before
 * the parent unmounts, so closing settles instead of cutting. Escape and the
 * focus boundary route through the same animated dismiss.
 */
export function ConfirmDialog({ request, onClose }: { request: ConfirmDialogRequest; onClose: () => void }) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const closedRef = useRef(false)

  /** Animate out, then run the parent callback (and the confirm action). */
  const dismiss = useCallback(
    (confirm: boolean) => {
      if (closedRef.current) return
      closedRef.current = true
      setClosing(true)
      const finish = () => {
        onClose()
        if (confirm) request.onConfirm()
      }
      if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        finish()
        return
      }
      window.setTimeout(finish, 110)
    },
    [onClose, request]
  )

  useModalBoundary(dialogRef, true, () => dismiss(false))

  return (
    <div className={`dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 ${closing ? 'is-closing' : ''}`}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        className={`dialog-panel w-96 rounded-xl border border-line bg-ink-900 p-4 shadow-pop ${closing ? 'is-closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[12px] font-medium text-cream">{request.title}</div>
        <p className="text-[12px] leading-5 text-cream-dim">{request.body}</p>
        <div className="mt-3 flex justify-end gap-1.5">
          <button
            autoFocus
            onClick={() => dismiss(false)}
            className="rounded-full border border-line px-3 py-1 text-[11.5px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => dismiss(true)}
            className={
              request.danger
                ? 'rounded-full bg-red-500 px-3 py-1 text-[11.5px] font-medium text-white transition hover:bg-red-600'
                : 'rounded-full bg-cream px-3 py-1 text-[11.5px] font-medium text-ink-950 transition hover:opacity-90'
            }
          >
            {request.confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
