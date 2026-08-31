import { useMemo, useState } from 'react'
import { Check, Palette, X } from 'lucide-react'
import { parseBoardDesign } from '@shared/boardDesign'
import { BoardDesignIssue } from '@shared/types'
import { useT } from '../i18n'

/**
 * Rich renderer for ```board-design fences in chat. This is the human
 * confirmation step of the chat → board-style path: the agent only PROPOSES
 * a design document; nothing is written until the person clicks Apply, and
 * Main re-validates (and refuses) any document with parse errors.
 */
export default function BoardDesignBlock({ raw }: { raw: string }) {
  const t = useT()
  const { spec, issues } = useMemo(() => parseBoardDesign(raw), [raw])
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'applied'>('idle')
  const [applyIssues, setApplyIssues] = useState<BoardDesignIssue[]>([])

  const errors = issues.filter((issue) => issue.level === 'error')
  const tokens: { key: string; value: string }[] = [
    ...Object.entries(spec.board).map(([key, value]) => ({ key: `board.${key}`, value: String(value) })),
    ...Object.entries(spec.widget).map(([key, value]) => ({ key: `widget.${key}`, value: String(value) }))
  ]
  const applicable = errors.length === 0 && tokens.length > 0 && applyState !== 'applied'

  const apply = async () => {
    if (!applicable || applyState === 'applying') return
    setApplyState('applying')
    try {
      const result = await window.electronAPI.saveBoardDesign(raw)
      if (result.ok) {
        setApplyState('applied')
        setApplyIssues([])
      } else {
        setApplyState('idle')
        setApplyIssues(result.issues.filter((issue) => issue.level === 'error'))
      }
    } catch {
      setApplyState('idle')
      setApplyIssues([])
    }
  }

  const shownIssues = [...applyIssues, ...issues]

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-ink-800">
      <div className="flex items-center justify-between border-b border-line bg-overlay px-3 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-cream-faint">
          <Palette size={11} />
          {t('boards.design.blockTitle')}
        </span>
        <button
          onClick={() => void apply()}
          disabled={!applicable || applyState === 'applying'}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-cream-faint transition enabled:hover:bg-overlay-strong enabled:hover:text-cream disabled:opacity-40"
        >
          {applyState === 'applied' ? <Check size={11} className="text-green-400" /> : null}
          {applyState === 'applied'
            ? t('boards.design.applied')
            : applyState === 'applying'
              ? t('boards.design.applying')
              : t('boards.design.apply')}
        </button>
      </div>
      <div className="p-3.5">
        {tokens.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {tokens.map((token) => (
              <span
                key={token.key}
                className="flex items-center gap-1.5 rounded-md border border-line bg-ink-850 px-1.5 py-0.5 font-mono text-[10.5px] text-cream-dim"
              >
                {/^#[0-9a-f]{6}$/i.test(token.value) && (
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm border border-line"
                    style={{ backgroundColor: token.value }}
                  />
                )}
                {token.key}: {token.value}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-cream-faint">{t('boards.design.empty')}</p>
        )}
        {errors.length > 0 && (
          <p className="mt-2 flex items-center gap-1 text-[11px] text-red-400">
            <X size={11} />
            {t('boards.design.invalid')}
          </p>
        )}
        {shownIssues.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {shownIssues.map((issue, index) => (
              <li
                key={`${issue.line}-${index}`}
                className={`text-[11px] ${issue.level === 'error' ? 'text-red-400' : 'text-cream-faint'}`}
              >
                {t('boards.design.line', { line: issue.line })} · {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
