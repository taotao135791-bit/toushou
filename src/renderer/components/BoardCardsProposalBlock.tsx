import { useEffect, useMemo, useState } from 'react'
import { Check, FileCode2, Hash, LayoutDashboard, ListTodo, StickyNote, X, type LucideIcon } from 'lucide-react'
import { parseBoardCardsProposal } from '@shared/boardCards'
import { BoardCardsCard, BoardCardsIssue, KanbanBoard } from '@shared/types'
import { useT, I18nKey } from '../i18n'
import { useAppStore } from '../store'

/**
 * Rich renderer for ```board-cards fences in chat — the human confirmation
 * step of the chat → board-cards path. The agent only PROPOSES cards; this
 * block previews them, lets the person pick a target board, and applies by
 * handing the RAW fence text to Main, which re-parses and re-validates
 * everything before touching a board (the agent can never write boards).
 */

const CARD_ICON: Record<BoardCardsCard['type'], LucideIcon> = {
  metric: Hash,
  list: ListTodo,
  note: StickyNote,
  file: FileCode2
}

function cardLines(cardText: string, max: number): string {
  return cardText.length > max ? `${cardText.slice(0, Math.max(0, max - 1))}…` : cardText
}

function CardPreview({ card }: { card: BoardCardsCard }) {
  const t = useT()
  const Icon = CARD_ICON[card.type]
  return (
    <div className="rounded-xl border border-line bg-ink-850 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Icon size={11} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-cream">{card.title}</span>
        <span className="shrink-0 text-[9.5px] uppercase tracking-[0.12em] text-cream-faint">{card.type}</span>
      </div>
      {card.type === 'metric' && (
        <div className="mt-1.5 flex items-baseline gap-1.5 pl-7">
          <span className="font-mono text-[18px] leading-none tabular-nums text-cream">
            {card.value.toLocaleString()}
          </span>
          {card.unit && <span className="text-[10.5px] text-cream-faint">{card.unit}</span>}
          {card.delta !== undefined && (
            <span className={`text-[10.5px] ${card.delta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {card.delta >= 0 ? '+' : ''}
              {card.delta}
              {card.deltaLabel ? ` ${card.deltaLabel}` : ''}
            </span>
          )}
        </div>
      )}
      {card.type === 'list' && (
        <ul className="mt-1.5 space-y-0.5 pl-7">
          {card.items.slice(0, 4).map((item, index) => (
            <li key={index} className="truncate text-[11px] leading-4 text-cream-dim">
              · {item}
            </li>
          ))}
          {card.items.length > 4 && (
            <li className="text-[10.5px] text-cream-faint">
              {t('boards.cards.moreItems', { count: card.items.length - 4 })}
            </li>
          )}
        </ul>
      )}
      {card.type === 'note' && (
        <p className="mt-1.5 pl-7 text-[11px] leading-4 text-cream-dim">{cardLines(card.text, 160)}</p>
      )}
      {card.type === 'file' && (
        <p className="mt-1.5 truncate pl-7 font-mono text-[10.5px] text-cream-dim" title={card.filePath}>
          {card.filePath}
        </p>
      )}
    </div>
  )
}

export default function BoardCardsProposalBlock({ raw }: { raw: string }) {
  const t = useT()
  const currentWorkspace = useAppStore((state) => state.currentWorkspace)
  const parsed = useMemo(() => parseBoardCardsProposal(raw), [raw])
  const [boards, setBoards] = useState<KanbanBoard[] | null>(null)
  const [boardId, setBoardId] = useState('')
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'applied'>('idle')
  const [appliedCount, setAppliedCount] = useState(0)
  const [applyIssues, setApplyIssues] = useState<BoardCardsIssue[]>([])
  const [applyError, setApplyError] = useState<I18nKey | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let alive = true
    void window.electronAPI
      .listBoards()
      .then((items) => {
        if (!alive) return
        setBoards(items)
        setBoardId((current) => current || items[0]?.id || '')
      })
      .catch(() => {
        if (alive) setBoards([])
      })
    return () => {
      alive = false
    }
  }, [])

  const needsWorkspace = parsed.ok && parsed.proposal.cards.some((card) => card.type === 'file')
  const errors = parsed.ok ? [] : parsed.issues.filter((issue) => issue.level === 'error')
  const applicable =
    parsed.ok &&
    errors.length === 0 &&
    !!boardId &&
    applyState === 'idle' &&
    !dismissed &&
    (!needsWorkspace || !!currentWorkspace)

  const apply = async () => {
    // `applicable` already excludes the applying/applied states.
    if (!applicable) return
    setApplyState('applying')
    setApplyIssues([])
    setApplyError(null)
    try {
      const result = await window.electronAPI.applyBoardCards({
        boardId,
        raw,
        ...(needsWorkspace && currentWorkspace ? { workspaceGrantId: currentWorkspace.id } : {})
      })
      if (result.ok) {
        setAppliedCount(result.widgetIds.length)
        setApplyState('applied')
      } else {
        setApplyState('idle')
        setApplyIssues(result.issues.filter((issue) => issue.level === 'error'))
        setApplyError(
          result.error === 'not-found'
            ? 'boards.cards.boardMissing'
            : result.error === 'no-workspace'
              ? 'boards.cards.needWorkspace'
              : 'boards.cards.applyFailed'
        )
      }
    } catch {
      setApplyState('idle')
      setApplyError('boards.cards.applyFailed')
    }
  }

  if (dismissed) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-ink-800 px-3 py-2 text-[11px] text-cream-faint">
        <LayoutDashboard size={11} />
        {t('boards.cards.ignored')}
      </div>
    )
  }

  const shownIssues = [...applyIssues, ...parsed.issues]

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-ink-800">
      <div className="flex items-center justify-between border-b border-line bg-overlay px-3 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-cream-faint">
          <LayoutDashboard size={11} />
          {t('boards.cards.blockTitle')}
        </span>
        {applyState !== 'applied' && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDismissed(true)}
              className="rounded px-1.5 py-0.5 text-[10px] text-cream-faint transition hover:bg-overlay-strong hover:text-cream"
            >
              {t('boards.cards.ignore')}
            </button>
            <button
              onClick={() => void apply()}
              disabled={!applicable}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-cream-faint transition enabled:hover:bg-overlay-strong enabled:hover:text-cream disabled:opacity-40"
            >
              {applyState === 'applying' ? t('boards.cards.applying') : t('boards.cards.apply')}
            </button>
          </div>
        )}
      </div>
      <div className="space-y-2 p-3.5">
        {parsed.ok ? (
          <>
            {applyState === 'applied' ? (
              <p className="flex items-center gap-1.5 text-[12px] text-green-400">
                <Check size={12} />
                {t('boards.cards.applied', { count: appliedCount })}
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  {parsed.proposal.cards.map((card, index) => (
                    <CardPreview key={index} card={card} />
                  ))}
                </div>
                {needsWorkspace && !currentWorkspace && (
                  <p className="text-[11px] text-amber-400">{t('boards.cards.needWorkspace')}</p>
                )}
                {boards === null ? (
                  <p className="text-[11px] text-cream-faint">{t('app.loading')}</p>
                ) : boards.length === 0 ? (
                  <p className="text-[11px] text-cream-faint">{t('boards.cards.noBoards')}</p>
                ) : (
                  <label className="flex items-center gap-2">
                    <span className="shrink-0 text-[11px] text-cream-faint">{t('boards.cards.pickBoard')}</span>
                    <select
                      value={boardId}
                      onChange={(event) => setBoardId(event.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-ink-850 px-2 py-1 text-[12px] text-cream outline-none focus:border-accent/50"
                    >
                      {boards.map((board) => (
                        <option key={board.id} value={board.id}>
                          {board.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
          </>
        ) : (
          <p className="flex items-center gap-1 text-[11px] text-red-400">
            <X size={11} />
            {t('boards.cards.invalid')}
          </p>
        )}
        {applyError && (
          <p role="alert" className="text-[11px] text-red-400">
            {t(applyError)}
          </p>
        )}
        {shownIssues.length > 0 && (
          <ul className="space-y-0.5">
            {shownIssues.map((issue, index) => (
              <li
                key={`${issue.card}-${index}`}
                className={`text-[11px] ${issue.level === 'error' ? 'text-red-400' : 'text-cream-faint'}`}
              >
                {issue.card !== null ? t('boards.cards.card', { card: issue.card + 1 }) + ' · ' : ''}
                {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
