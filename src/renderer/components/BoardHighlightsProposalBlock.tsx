import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseBoardHighlights, type BoardHighlightMetric, type BoardHighlightsApplyResult, type BoardHighlightsProposal, type BoardHighlightsValidationResult } from '@shared/boardHighlights'
import { useAppStore } from '../store'

type Api = {
  validateBoardHighlights(input: { raw: string }): Promise<BoardHighlightsValidationResult>
  applyBoardHighlights(input: { raw: string }): Promise<BoardHighlightsApplyResult>
}
const metricLabels: Record<BoardHighlightMetric, [string, string]> = {
  spend: ['消耗', 'Spend'], previousSpend: ['上期消耗', 'Prior spend'], impressions: ['展示', 'Impressions'], clicks: ['点击', 'Clicks'], conversions: ['结果', 'Results']
}

/** Human review surface for an untrusted, evidence-bound model proposal. */
export default function BoardHighlightsProposalBlock({ raw }: { raw: string }) {
  const navigate = useNavigate()
  const idPrefix = useId()
  const zh = useAppStore(state => state.language) === 'zh'
  const initial = useMemo(() => parseBoardHighlights(raw), [raw])
  const [draftState, setDraftState] = useState<{ source: string; value: BoardHighlightsProposal | null }>({ source: raw, value: initial })
  const [checked, setChecked] = useState<{ raw: string; result: BoardHighlightsValidationResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState(false)
  const [actionError, setActionError] = useState(false)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const draft = draftState.source === raw ? draftState.value : null
  const payload = draft ? JSON.stringify(draft) : ''
  const latest = useRef(payload)
  latest.current = payload
  const getApi = (): Api | null => typeof window === 'undefined' || !window.electronAPI ? null : window.electronAPI as typeof window.electronAPI & Api

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current += 1 } }, [])

  useEffect(() => {
    setDraftState({ source: raw, value: initial })
    setChecked(null); setApplied(false); setActionError(false)
  }, [raw, initial])
  useEffect(() => {
    const id = ++sequence.current
    setChecked(null)
    if (!payload) return
    const api = getApi()
    if (!api?.validateBoardHighlights) { setChecked({ raw: payload, result: { ok: false, error: 'write-failed' } }); return }
    void api.validateBoardHighlights({ raw: payload }).then(result => {
      if (sequence.current === id && latest.current === payload) setChecked({ raw: payload, result })
    }).catch(() => {
      if (sequence.current === id && latest.current === payload) setChecked({ raw: payload, result: { ok: false, error: 'write-failed' } })
    })
    return () => { sequence.current += 1 }
  }, [payload])
  const result = checked?.raw === payload ? checked.result : null
  const valid = result?.ok === true
  const updateText = (index: number, text: string) => {
    setDraftState(current => current.source !== raw || !current.value ? current : { source: raw, value: { ...current.value, highlights: current.value.highlights.map((item, i) => i === index ? { ...item, text } : item) } })
    setApplied(false); setActionError(false)
  }
  const apply = async () => {
    if (!valid || busy || applied || !payload) return
    setBusy(true); setActionError(false)
    try {
      const api = getApi()
      if (!api?.applyBoardHighlights) throw new Error('unavailable')
      const res = await api.applyBoardHighlights({ raw: payload })
      if (!mounted.current || latest.current !== payload) return
      if (res.ok) setApplied(true)
      else { setActionError(true); setChecked({ raw: payload, result: { ok: false, error: res.error } }) }
    } catch { if (mounted.current) setActionError(true) } finally { if (mounted.current) setBusy(false) }
  }
  const reveal = async (index: number) => {
    if (!valid || busy || !payload) return
    setBusy(true); setActionError(false)
    try {
      const api = getApi()
      if (!api?.validateBoardHighlights) throw new Error('unavailable')
      const verified = await api.validateBoardHighlights({ raw: payload })
      if (!mounted.current || latest.current !== payload) return
      if (!verified.ok || !verified.evidence.accounts.some(a => a.index === index && a.status === 'ok')) {
        setActionError(true); setChecked({ raw: payload, result: verified.ok ? { ok: false, error: 'invalid-evidence' } : verified }); return
      }
      const query = new URLSearchParams({ evidenceBoard: verified.evidence.boardId, evidenceWidget: verified.evidence.widgetId, evidenceIndex: String(index), evidenceRevision: verified.evidence.revision })
      navigate(`/boards?${query.toString()}`)
    } catch { if (mounted.current) setActionError(true) } finally { if (mounted.current) setBusy(false) }
  }
  if (!draft) return <div role="status" className="rounded-lg border border-line p-3 text-[12px] text-cream-dim">{zh ? '高光提议格式不完整，无法验证或应用。' : 'Incomplete highlight proposal; it cannot be verified or applied.'}</div>
  return <section aria-label={zh ? '高光提议' : 'Highlight proposal'} className="rounded-xl border border-line bg-ink-850 p-4 text-[13px] text-cream">
    <h3 className="font-semibold">{zh ? '高光提议 · 人工审核' : 'Highlight proposal · review required'}</h3>
    <p className="mt-1 text-[12px] text-cream-faint">{zh ? '引用数字与快照核对；自然语言解释不自动保证正确。编辑后需重新核验。' : 'Cited numbers are checked against the snapshot; prose is not automatically verified. Edits are checked again.'}</p>
    {!result && <p role="status" className="mt-2 text-[12px] text-cream-faint">{zh ? '正在核验证据…' : 'Checking evidence…'}</p>}
    {result && !result.ok && <p role="alert" className="mt-2 text-[12px] text-red-500">{zh ? '证据已变化、缺失、不可用或文本包含账户标识；请重新生成或编辑。' : 'Evidence is stale, missing or unavailable, or text contains an account identifier. Regenerate or edit.'}</p>}
    {draft.highlights.map((item, index) => <div key={index} className="mt-3 rounded-lg border border-line p-3">
      <label className="block text-[12px] text-cream-dim" htmlFor={`${idPrefix}-highlight-${index}`}>{zh ? `观察 ${index + 1}` : `Observation ${index + 1}`}</label>
      <textarea id={`${idPrefix}-highlight-${index}`} value={item.text} maxLength={280} disabled={busy || applied} onChange={event => updateText(index, event.target.value)} className="mt-1 w-full rounded border border-line bg-ink-900 p-2 text-[13px] text-cream" />
      <div className="mt-2 flex flex-wrap gap-2">{item.evidence.map((ref, i) => {
        const account = result?.ok ? result.evidence.accounts.find(a => a.index === ref.accountIndex) : undefined
        const period = ref.metric === 'previousSpend' ? account?.previousWindow : account?.window
        const unit = ref.metric === 'spend' || ref.metric === 'previousSpend' ? ` ${account?.currency ?? ''}` : ''
        return <button type="button" key={`${ref.accountIndex}-${ref.metric}-${i}`} disabled={!valid || busy} onClick={() => void reveal(ref.accountIndex)} className="focus-ring rounded border border-line px-2 py-1 text-[12px] disabled:opacity-40">
          {account?.platform ?? '—'} · {zh ? '账户' : 'Account'} {ref.accountIndex} · {metricLabels[ref.metric][zh ? 0 : 1]} {ref.value}{unit}{period ? ` · ${period.start} – ${period.end}` : ''} ↗
        </button>
      })}</div>
    </div>)}
    {actionError && <p role="alert" className="mt-2 text-[12px] text-red-500">{zh ? '操作未完成，请重新核验。' : 'Action failed; check the evidence again.'}</p>}
    <div className="mt-3 flex items-center gap-3"><button type="button" disabled={!valid || busy || applied} onClick={() => void apply()} className="focus-ring rounded-full bg-accent px-3 py-1.5 text-[12px] text-white disabled:opacity-40">{applied ? (zh ? '已加入看板' : 'Added to board') : (zh ? '确认并加入看板' : 'Confirm and add to board')}</button><span role="status" className="text-[12px] text-cream-faint">{valid ? (zh ? '数字引用已核对' : 'Cited values checked') : ''}</span></div>
  </section>
}
