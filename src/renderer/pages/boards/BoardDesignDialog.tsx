import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, FolderOpen, MessageSquareText, X } from 'lucide-react'
import { parseBoardDesign } from '@shared/boardDesign'
import { buildBoardDesignPrompt } from '@shared/boardChat'
import { useT } from '../../i18n'
import { useAppStore } from '../../store'

/**
 * In-app editor for userData/board-design.md — the bounded, line-based design
 * document that supplies board appearance defaults. Saving is validated in
 * Main (documents with parse errors are refused) and the same file can be
 * edited externally; open boards follow the file via boards:design-changed.
 */
export function BoardDesignDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    let alive = true
    window.electronAPI
      .getBoardDesign()
      .then((doc) => {
        if (alive) setDraft(doc.markdown)
      })
      .catch(() => {
        if (alive) setDraft('')
      })
    return () => {
      alive = false
    }
  }, [])

  // Live, local parse feedback; Main re-validates authoritatively on save.
  const issues = useMemo(() => (draft === null ? [] : parseBoardDesign(draft).issues), [draft])
  const errorCount = issues.filter((issue) => issue.level === 'error').length

  const save = async () => {
    if (draft === null || saving) return
    setSaving(true)
    setSaveError(false)
    try {
      const result = await window.electronAPI.saveBoardDesign(draft)
      if (result.ok) {
        onSaved()
        onClose()
      } else {
        setSaveError(true)
      }
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  /** Hand the agent a bounded format brief + the current draft; never auto-applied. */
  const askAi = () => {
    const store = useAppStore.getState()
    const existing = store.currentSessionId ? store.composerDrafts[store.currentSessionId]?.text.trim() : ''
    const prompt = buildBoardDesignPrompt(draft ?? '')
    store.setComposerPrefill(existing ? `${existing}\n\n${prompt}` : prompt)
    navigate('/')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="fade-in flex w-full max-w-[520px] flex-col rounded-2xl border border-line bg-ink-900 p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-semibold text-cream">{t('boards.design.title')}</span>
          <button
            onClick={onClose}
            title={t('boards.cancel')}
            className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-2 text-[11.5px] leading-4 text-cream-faint">{t('boards.design.hint')}</p>
        {draft === null ? (
          <div className="mt-4 py-8 text-center text-[12px] text-cream-faint">{t('app.loading')}</div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setSaveError(false)
            }}
            rows={14}
            spellCheck={false}
            className="mt-3 w-full resize-none rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 font-mono text-[11.5px] leading-5 text-cream outline-none transition placeholder:text-cream-faint focus:border-accent/50"
          />
        )}
        {issues.length > 0 ? (
          <ul className="mt-2 max-h-24 space-y-0.5 overflow-y-auto">
            {issues.map((issue, index) => (
              <li
                key={`${issue.line}-${index}`}
                className={`text-[11px] ${issue.level === 'error' ? 'text-red-400' : 'text-cream-faint'}`}
              >
                {t('boards.design.line', { line: issue.line })} · {issue.message}
              </li>
            ))}
          </ul>
        ) : (
          draft !== null && <p className="mt-2 text-[11px] text-cream-faint">{t('boards.design.valid')}</p>
        )}
        {saveError && <p className="mt-2 text-[11px] text-red-400">{t('boards.design.saveFailed')}</p>}
        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => void window.electronAPI.revealBoardDesign()}
              className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
            >
              <FolderOpen size={11} />
              {t('boards.design.reveal')}
            </button>
            <button
              onClick={askAi}
              className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
            >
              <MessageSquareText size={11} />
              {t('boards.design.askAi')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
            >
              {t('boards.cancel')}
            </button>
            <button
              onClick={() => void save()}
              disabled={draft === null || saving || errorCount > 0}
              className="flex items-center gap-1 rounded-full bg-cream px-3 py-1.5 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
            >
              <Check size={11} />
              {t('boards.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
