import { useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react'
import type { ReadingEvidence, ReadingEvidenceKind } from '@shared/readingEvidence'
import { useT, type I18nKey } from '../../i18n'

const KIND_LABEL: Record<ReadingEvidenceKind, I18nKey> = {
  panel: 'boards.evidence.kind.panel',
  csv: 'boards.evidence.kind.csv',
  link: 'boards.evidence.kind.link',
  mcp: 'boards.evidence.kind.mcp'
}

const INCLUDED_LABEL = {
  campaigns: 'boards.evidence.included.campaigns',
  accounts: 'boards.evidence.included.accounts'
} as const

/**
 * One collapsed line under a reading widget: where the numbers came from, when,
 * and which window they cover — expandable into the full evidence trail
 * (source detail, scope notes, coverage, excluded accounts, warnings).
 * Data comes from the shared per-platform projections in readingEvidence.ts.
 */
export function ReadingEvidenceLine({ evidence }: { evidence: ReadingEvidence }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const captured = evidence.capturedAt === null ? null : new Date(evidence.capturedAt).toLocaleString()
  const kindLabel = t(KIND_LABEL[evidence.kind])
  const sourceLabel = evidence.auth
    ? `${kindLabel} · ${t(evidence.auth === 'oauth' ? 'boards.evidence.auth.oauth' : 'boards.evidence.auth.pasted')}`
    : kindLabel

  return (
    <div className="text-[12px] leading-[18px] text-cream-faint">
      <div className="flex flex-wrap items-center gap-x-1.5">
        <ShieldCheck size={12} aria-hidden="true" />
        <span>
          {sourceLabel}
          {captured ? ` · ${t('boards.evidence.capturedAt', { time: captured })}` : ''}
          {evidence.scopeLabel ? ` · ${evidence.scopeLabel}` : ''}
        </span>
        {evidence.warnings.length > 0 && <span aria-label={t('boards.evidence.warnings', { value: '' })}>⚠ {evidence.warnings.length}</span>}
        <button
          type="button"
          className="focus-ring inline-flex items-center gap-1 rounded px-1 underline-offset-2 hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          {t(open ? 'boards.evidence.hide' : 'boards.evidence.toggle')}
        </button>
      </div>
      {open && (
        <dl className="mt-1 flex flex-col gap-0.5 pl-[18px]">
          {evidence.sourceDetail && (
            <div className="flex gap-1.5"><dt aria-hidden="true">·</dt><dd>{t('boards.evidence.sourceDetail', { value: evidence.sourceDetail })}</dd></div>
          )}
          {evidence.scopeDetails.length > 0 && (
            <div className="flex gap-1.5"><dt aria-hidden="true">·</dt><dd>{t('boards.evidence.scopeDetails', { value: evidence.scopeDetails.join(' · ') })}</dd></div>
          )}
          {evidence.includedCount !== null && evidence.includedUnit && (
            <div className="flex gap-1.5"><dt aria-hidden="true">·</dt><dd>{t(INCLUDED_LABEL[evidence.includedUnit], { count: evidence.includedCount })}</dd></div>
          )}
          {evidence.excludedNames.length > 0 && (
            <div className="flex gap-1.5"><dt aria-hidden="true">·</dt><dd>{t('boards.evidence.excluded', { value: evidence.excludedNames.join('、') })}</dd></div>
          )}
          {evidence.warnings.length > 0 && (
            <div className="flex gap-1.5"><dt aria-hidden="true">·</dt><dd>{t('boards.evidence.warnings', { value: evidence.warnings.join('、') })}</dd></div>
          )}
        </dl>
      )}
    </div>
  )
}
