import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { useModalBoundary } from '../lib/modalBoundary'

export default function SessionInstructionDialog({ session, onClose, fallbackFocus }: {
  session: { id: string; title: string }
  onClose: () => void
  fallbackFocus: RefObject<HTMLElement>
}) {
  const t = useT()
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<'load' | 'save' | null>(null)
  const [saving, setSaving] = useState(false)
  const close = () => { if (!saving) onClose() }
  useModalBoundary(dialog, true, close, { initialFocus: dialog, fallbackFocus })

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.sessionInstruction(session.id).then(value => {
      if (cancelled) return
      setSaved(value)
      setDraft(value)
    }).catch(() => { if (!cancelled) setError('load') })
    return () => { cancelled = true }
  }, [session.id])

  useEffect(() => {
    if (saved !== null && document.activeElement === dialog.current) input.current?.focus()
  }, [saved])

  async function save(value: string) {
    setSaving(true)
    setError(null)
    try {
      if (await window.electronAPI.setSessionInstruction(session.id, value)) {
        onClose()
        return
      }
      setError('save')
    } catch {
      setError('save')
    } finally {
      setSaving(false)
    }
  }

  const loading = saved === null && error === null
  const trimmed = draft.trim()
  return createPortal(
    <div className="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="session-instruction-title" aria-describedby="session-instruction-name session-instruction-hint"
        aria-busy={loading || saving} className="dialog-panel w-full max-w-lg rounded-xl border border-line bg-ink-900 p-4 shadow-pop">
        <h3 id="session-instruction-title" className="text-[13px] font-medium text-cream">{t('chat.instruction.title')}</h3>
        <p id="session-instruction-name" className="mt-1 truncate text-xs text-cream" title={session.title}>{session.title}</p>
        <p id="session-instruction-hint" className="mb-3 mt-1 text-xs text-cream-dim">{t('chat.instruction.hint')}</p>
        {loading && <p role="status" className="py-3 text-xs text-cream-dim">{t('app.loading')}</p>}
        {saved !== null && <textarea
          ref={input}
          aria-labelledby="session-instruction-title"
          aria-describedby="session-instruction-hint"
          value={draft}
          onChange={event => setDraft(event.currentTarget.value)}
          rows={6}
          maxLength={4000}
          disabled={saving}
          placeholder={t('chat.instruction.placeholder')}
          className="focus-ring w-full resize-y rounded-lg border border-line bg-ink-850 px-3 py-2 text-xs text-cream placeholder-cream-faint"
        />}
        {error && <p role="alert" className="mt-2 text-xs text-red-500">{t(error === 'load' ? 'chat.instruction.loadFailed' : 'chat.instruction.busy')}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {saved && <button type="button" onClick={() => void save('')} disabled={saving}
            className="focus-ring mr-auto rounded-full px-3 py-1 text-xs text-cream-dim hover:bg-overlay disabled:opacity-50">
            {t('chat.instruction.clear')}
          </button>}
          <button type="button" onClick={close} disabled={saving}
            className="focus-ring rounded-full border border-line px-3 py-1 text-xs text-cream-dim hover:bg-overlay disabled:opacity-50">
            {t('common.cancel')}
          </button>
          {saved !== null && <button type="button" onClick={() => void save(trimmed)} disabled={saving || !trimmed || saved === trimmed}
            className="focus-ring rounded-full bg-cream px-3 py-1 text-xs font-medium text-ink-950 hover:opacity-90 disabled:opacity-50">
            {t('chat.instruction.apply')}
          </button>}
        </div>
      </div>
    </div>,
    document.body
  )
}
