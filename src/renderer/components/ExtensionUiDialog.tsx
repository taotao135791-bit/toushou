import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { MessageCircleQuestion, X } from 'lucide-react'
import { ExtensionUiAnswer } from '@shared/types'
import { UiRequest, useAppStore } from '../store'
import { useT } from '../i18n'

/**
 * Modal dialog for pi extension UI requests (select / confirm / input / editor).
 * Extensions pause mid-turn until the answer goes back over the session stdin;
 * cancelling returns `{ cancelled: true }`, which pi treats as a dismissed dialog.
 *
 * A request may carry a timeout (ms). The runtime resolves the dialog with its
 * default at the deadline WITHOUT notifying the client, so the dialog runs its
 * own countdown and cancels itself — otherwise it would sit there stale.
 */
export default function ExtensionUiDialog({
  sessionId,
  request
}: {
  sessionId: string
  request: UiRequest
}) {
  const t = useT()
  const resolveUiRequest = useAppStore((s) => s.resolveUiRequest)
  const [text, setText] = useState(request.method === 'editor' ? request.prefill ?? '' : '')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState(false)
  const [remaining, setRemaining] = useState<number | null>(
    request.timeout !== undefined ? Math.ceil(request.timeout / 1000) : null
  )
  const dialogRef = useRef<HTMLDivElement>(null)
  const timeoutAttempted = useRef(false)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    setText(request.method === 'editor' ? request.prefill ?? '' : '')
    setSending(false)
    setSendError(false)
    setRemaining(request.timeout !== undefined ? Math.ceil(request.timeout / 1000) : null)
    timeoutAttempted.current = false
  }, [request.id, request.method, request.prefill, request.timeout])

  // A modal must own focus. The request controls mark their intended first
  // target, so select/confirm dialogs are keyboard-usable too.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus()
  }, [request.id, request.method])

  const answer = useCallback(
    async (a: ExtensionUiAnswer) => {
      if (sending) return
      setSending(true)
      setSendError(false)
      let accepted = false
      try {
        accepted = await window.electronAPI.respondUi(sessionId, request.id, a)
        if (!accepted) {
          setSendError(true)
          return
        }
        resolveUiRequest(sessionId, request.id)
      } catch {
        setSendError(true)
      } finally {
        // Keep the request visible when Main could not write it. The user can
        // retry or cancel instead of seeing a disappearing dialog and a turn
        // that remains waiting_for_user upstream.
        if (!accepted) setSending(false)
      }
    },
    [sending, sessionId, request.id, resolveUiRequest]
  )

  // Countdown to the runtime's deadline: auto-cancel when it hits zero.
  useEffect(() => {
    if (remaining === null) return
    if (remaining <= 0) {
      if (!timeoutAttempted.current) {
        timeoutAttempted.current = true
        void answer({ cancelled: true })
      }
      return
    }
    const timer = setTimeout(() => setRemaining((r) => (r === null ? null : r - 1)), 1000)
    return () => clearTimeout(timer)
  }, [remaining, answer])

  // Escape cancels the dialog (same as the X / Cancel button).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void answer({ cancelled: true })
        return
      }
      if (e.key === 'Tab') {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href]'
          ) ?? []
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [answer])

  const isTextual = request.method === 'input' || request.method === 'editor'

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-ink-950/30 p-6 backdrop-blur-[2px]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="msg-in w-full max-w-[420px] rounded-[18px] border border-line bg-ink-850 shadow-pop"
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
            <MessageCircleQuestion size={14} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="truncate text-[14px] font-semibold text-cream">
              {request.title || t('uiDialog.untitled')}
            </h3>
            <p id={descriptionId} className="mt-0.5 text-[11px] text-cream-faint">
              {t('uiDialog.subtitle')}
              {remaining !== null && ` · ${t('uiDialog.timeout', { count: remaining })}`}
            </p>
          </div>
          <button
            onClick={() => answer({ cancelled: true })}
            disabled={sending}
            className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
            title={t('uiDialog.cancel')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4">
          {request.method === 'select' && (
            <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
              {/* Approval-style requests pack a command summary into a long
                  title; show it in full as a mono block the header can't fit. */}
              {request.title.length > 48 && (
                <div className="mb-1 whitespace-pre-wrap break-words rounded-lg bg-ink-800 p-3 font-mono text-[12px] leading-5 text-cream/85">
                  {request.title}
                </div>
              )}
              {request.message && (
                <p className="mb-1 whitespace-pre-wrap text-[13px] leading-6 text-cream-dim">
                  {request.message}
                </p>
              )}
              {(request.options ?? []).map((option, i) => (
                <button
                  key={option}
                  onClick={() => answer({ value: option })}
                  disabled={sending}
                  data-dialog-autofocus={i === 0 ? true : undefined}
                  className={`rounded-lg border px-3 py-2 text-left text-[13px] transition ${
                    i === 0
                      ? 'border-accent/60 text-cream hover:bg-accent-soft'
                      : 'border-line text-cream hover:border-ink-600 hover:bg-overlay'
                  }`}
                >
                  {option}
                </button>
              ))}
              {(request.options ?? []).length === 0 && (
                <p className="text-[12px] text-cream-faint">{t('uiDialog.noOptions')}</p>
              )}
              <button
                onClick={() => answer({ cancelled: true })}
                disabled={sending}
                data-dialog-autofocus={(request.options ?? []).length === 0 ? true : undefined}
                className="mt-0.5 rounded-lg border border-line px-3 py-2 text-left text-[13px] text-cream-dim transition hover:border-red-500/40 hover:text-red-500"
              >
                {t('uiDialog.cancel')}
              </button>
            </div>
          )}

          {request.method === 'confirm' && (
            <>
              <p className="mb-4 whitespace-pre-wrap text-[13px] leading-6 text-cream-dim">
                {request.message}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => answer({ confirmed: false })}
                  disabled={sending}
                  data-dialog-autofocus
                  className="rounded-lg border border-line px-4 py-2 text-[13px] text-cream-dim transition hover:border-red-500/40 hover:text-red-500"
                >
                  {t('uiDialog.deny')}
                </button>
                <button
                  onClick={() => answer({ confirmed: true })}
                  disabled={sending}
                  className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:bg-accent-bright"
                >
                  {t('uiDialog.allow')}
                </button>
              </div>
            </>
          )}

          {isTextual && (
            <>
              {request.method === 'editor' ? (
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  autoFocus
                  data-dialog-autofocus
                  disabled={sending}
                  className="mb-4 w-full resize-y rounded-lg border border-line bg-ink-800 px-3 py-2.5 font-mono text-[12px] leading-5 text-cream outline-none transition-all focus:border-accent/50 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
                />
              ) : (
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={request.placeholder}
                  autoFocus
                  data-dialog-autofocus
                  disabled={sending}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') answer({ value: text })
                  }}
                  className="mb-4 w-full rounded-lg border border-line bg-ink-800 px-3 py-2.5 text-[13px] text-cream outline-none transition-all placeholder:text-cream-faint focus:border-accent/50 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
                />
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => answer({ cancelled: true })}
                  disabled={sending}
                  className="rounded-lg border border-line px-4 py-2 text-[13px] text-cream-dim transition hover:border-red-500/40 hover:text-red-500"
                >
                  {t('uiDialog.cancel')}
                </button>
                <button
                  onClick={() => answer({ value: text })}
                  disabled={sending}
                  className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:bg-accent-bright"
                >
                  {t('uiDialog.submit')}
                </button>
              </div>
            </>
          )}
          {sendError && (
            <p className="mt-3 text-[12px] text-red-500" role="alert">
              {t('uiDialog.sendFailed')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
