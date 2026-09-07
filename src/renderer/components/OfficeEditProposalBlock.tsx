import { useMemo, useState } from 'react'
import { Check, FileSpreadsheet, Send, X } from 'lucide-react'
import { parseOfficeEditProposal } from '@shared/officeEdit'
import { useT } from '../i18n'
import { useAppStore } from '../store'

/**
 * Rich renderer for ```office-edit fences in chat — the human confirmation
 * step of the chat → workbook path. The agent only PROPOSES cell edits; this
 * block previews them and, on explicit Apply, stages them in the store's
 * officeEditHandoff for the Office panel, where a second confirmation bar
 * writes the values into the in-memory Univer instance. Nothing is ever
 * written to disk here — saving stays on the user's own save-as flow.
 */

function previewValue(value: string | number | boolean, max = 60): string {
  const text = typeof value === 'string' ? value : String(value)
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

function EditRow({ edit }: { edit: { sheet: string; cell: string; value: string | number | boolean } }) {
  return (
    <tr className="border-t border-line/60">
      <td className="max-w-[110px] truncate px-2 py-1 text-cream-dim" title={edit.sheet}>
        {edit.sheet}
      </td>
      <td className="px-2 py-1 font-mono text-cream-dim">{edit.cell}</td>
      <td className="px-2 py-1 text-cream-faint">—</td>
      <td className="max-w-[160px] truncate px-2 py-1 font-mono text-cream" title={previewValue(edit.value, 200)}>
        {previewValue(edit.value)}
      </td>
    </tr>
  )
}

export default function OfficeEditProposalBlock({ raw }: { raw: string }) {
  const t = useT()
  const workspacePanel = useAppStore((state) => state.workspacePanel)
  const officeWorkbookOpen = useAppStore((state) => state.officeWorkbookOpen)
  const setWorkspacePanel = useAppStore((state) => state.setWorkspacePanel)
  const setOfficeEditHandoff = useAppStore((state) => state.setOfficeEditHandoff)
  const parsed = useMemo(() => parseOfficeEditProposal(raw), [raw])
  const [sent, setSent] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const errors = parsed.ok ? [] : parsed.issues.filter((issue) => issue.level === 'error')
  // Gating: when the Office panel is open but holds no workbook loaded from a
  // file, applying has nothing to land on. When the panel is closed (or on
  // another tab), Apply OPENS it and stages the handoff — the panel picks the
  // proposal up from the store on mount.
  const panelOpenOnOffice = workspacePanel?.kind === 'office'
  const needsWorkbook = panelOpenOnOffice && !officeWorkbookOpen
  const applicable = parsed.ok && errors.length === 0 && !sent && !dismissed && !needsWorkbook

  const apply = () => {
    if (!applicable || !parsed.ok) return
    setOfficeEditHandoff({
      id: crypto.randomUUID(),
      edits: parsed.proposal.edits,
      ...(parsed.proposal.note ? { note: parsed.proposal.note } : {})
    })
    if (!panelOpenOnOffice) setWorkspacePanel({ kind: 'office' })
    setSent(true)
  }

  if (dismissed) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-ink-800 px-3 py-2 text-[11px] text-cream-faint">
        <FileSpreadsheet size={11} />
        {t('office.edit.ignored')}
      </div>
    )
  }

  const shownIssues = parsed.issues

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-ink-800">
      <div className="flex items-center justify-between border-b border-line bg-overlay px-3 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-cream-faint">
          <FileSpreadsheet size={11} />
          {t('office.edit.blockTitle')}
        </span>
        {!sent && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDismissed(true)}
              className="rounded px-1.5 py-0.5 text-[10px] text-cream-faint transition hover:bg-overlay-strong hover:text-cream"
            >
              {t('office.edit.ignore')}
            </button>
            <button
              onClick={apply}
              disabled={!applicable}
              title={needsWorkbook ? t('office.edit.needWorkbook') : undefined}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-cream-faint transition enabled:hover:bg-overlay-strong enabled:hover:text-cream disabled:opacity-40"
            >
              <Send size={9} />
              {t('office.edit.apply')}
            </button>
          </div>
        )}
      </div>
      <div className="space-y-2 p-3.5">
        {parsed.ok ? (
          sent ? (
            <p className="flex items-center gap-1.5 text-[12px] text-green-400">
              <Check size={12} />
              {t('office.edit.sent')}
            </p>
          ) : (
            <>
              <p className="text-[11px] text-cream-dim">
                {t('office.edit.proposedCount', { count: parsed.proposal.edits.length })}
              </p>
              {parsed.proposal.note && (
                <p className="text-[11px] leading-4 text-cream-faint">{parsed.proposal.note}</p>
              )}
              <div className="overflow-x-auto rounded-lg border border-line bg-ink-850">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="text-[9.5px] uppercase tracking-[0.1em] text-cream-faint">
                      <th className="px-2 py-1 font-medium">{t('office.edit.sheet')}</th>
                      <th className="px-2 py-1 font-medium">{t('office.edit.cell')}</th>
                      <th className="px-2 py-1 font-medium">{t('office.edit.oldValue')}</th>
                      <th className="px-2 py-1 font-medium">{t('office.edit.newValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.proposal.edits.map((edit, index) => (
                      <EditRow key={index} edit={edit} />
                    ))}
                  </tbody>
                </table>
              </div>
              {needsWorkbook && (
                <p className="text-[11px] text-amber-400">{t('office.edit.needWorkbook')}</p>
              )}
            </>
          )
        ) : (
          <p className="flex items-center gap-1 text-[11px] text-red-400">
            <X size={11} />
            {t('office.edit.invalid')}
          </p>
        )}
        {shownIssues.length > 0 && (
          <ul className="space-y-0.5">
            {shownIssues.map((issue, index) => (
              <li
                key={`${issue.edit}-${index}`}
                className={`text-[11px] ${issue.level === 'error' ? 'text-red-400' : 'text-cream-faint'}`}
              >
                {issue.edit !== null ? t('office.edit.edit', { edit: issue.edit + 1 }) + ' · ' : ''}
                {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
