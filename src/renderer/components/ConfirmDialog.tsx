import { useEffect } from 'react'
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
 */
export function ConfirmDialog({ request, onClose }: { request: ConfirmDialogRequest; onClose: () => void }) {
  const t = useT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        className="w-96 rounded-xl border border-line bg-ink-900 p-4 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[12px] font-medium text-cream">{request.title}</div>
        <p className="text-[12px] leading-5 text-cream-dim">{request.body}</p>
        <div className="mt-3 flex justify-end gap-1.5">
          <button
            autoFocus
            onClick={onClose}
            className="rounded-full border border-line px-3 py-1 text-[11.5px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              onClose()
              request.onConfirm()
            }}
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
