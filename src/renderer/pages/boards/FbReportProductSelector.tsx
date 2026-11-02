import { useState } from 'react'
import { fbReportProducts, fbReportProductsConfig, selectedFbReportProduct, parseFbReportProducts, FB_REPORT_PRODUCT_LIMIT } from '@shared/fbReportProducts'
import type { BoardWidget } from '@shared/types'
import { parseFbReportReference } from '@shared/fbReportReference'
import { useT } from '../../i18n'

export function FbReportProductSelector({ widget, disabled, onConfigChange }: {
  widget: BoardWidget
  disabled: boolean
  onConfigChange: (config: Record<string, unknown>) => void
}) {
  const t = useT()
  const products = fbReportProducts(widget.config, widget.id)
  const selected = selectedFbReportProduct(widget.config, widget.id)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [reportName, setReportName] = useState('')
  const [reportId, setReportId] = useState('')
  const [error, setError] = useState(false)
  const button = 'focus-ring rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-50 disabled:opacity-50'
  const input = 'focus-ring min-w-0 rounded-md border border-neutral-300 bg-transparent px-2 py-1'
  const begin = (id: string) => {
    const p = products.find((p) => p.id === id)
    setEditing(id)
    setName(p?.name ?? '')
    setReportName(p?.reportName ?? '')
    setReportId(p?.reportId ?? '')
    setError(false)
  }
  const save = () => {
    if (disabled) return
    const old = products.find((p) => p.id === editing)
    const ref = reportId.trim() ? parseFbReportReference(reportId) : null
    if (reportId.trim() && !ref) { setError(true); return }
    const canonicalId = ref?.url ?? ref?.reportId
    // Renaming preserves data; rebinding must never relabel the previous report's data.
    const id = old && old.reportName === reportName.trim() && old.reportId === canonicalId ? old.id : crypto.randomUUID()
    const product = { id, name: name.trim(), reportName: reportName.trim(), ...(canonicalId ? { reportId: canonicalId } : {}) }
    const next = old ? products.map((p) => p.id === old.id ? product : p) : [...products, product]
    const validated = parseFbReportProducts(next)
    if (!validated) { setError(true); return }
    onConfigChange(fbReportProductsConfig(widget.config, validated, id))
    setEditing(null)
  }
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          {t('boards.fbReport.products.label')}
          <select
            aria-label={t('boards.fbReport.products.label')}
            className={`${input} max-w-64`}
            value={selected?.id ?? ''}
            disabled={disabled || editing !== null}
            onChange={(e) => onConfigChange(fbReportProductsConfig(widget.config, products, e.target.value))}
          >
            <option value="">{t('boards.fbReport.products.choose')}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <button type="button" className={button} disabled={disabled || products.length >= FB_REPORT_PRODUCT_LIMIT} onClick={() => begin('new')}>{t('boards.fbReport.products.add')}</button>
        <button type="button" className={button} disabled={disabled || !selected} onClick={() => selected && begin(selected.id)}>{t('boards.fbReport.products.edit')}</button>
      </div>
      {editing !== null && (
        <div role="group" aria-label={t('boards.fbReport.products.edit')} className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3">
          <label className="flex flex-col gap-1">{t('boards.fbReport.products.name')}<input className={input} maxLength={80} value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} /></label>
          <label className="flex flex-col gap-1">{t('boards.fbReport.config.reportName')}<input className={input} maxLength={80} value={reportName} disabled={disabled} onChange={(e) => setReportName(e.target.value)} /></label>
          <label className="flex flex-col gap-1">{t('boards.fbReport.config.reportId')}<input className={input} maxLength={2000} value={reportId} disabled={disabled} onChange={(e) => setReportId(e.target.value)} /></label>
          <p className="text-neutral-500">{t('boards.fbReport.products.bindingHint')}</p>
          {error && <p role="alert" className="text-red-600">{t('boards.fbReport.products.invalid')}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={disabled} onClick={save}>{t('boards.fbReport.products.save')}</button>
            <button type="button" className={button} disabled={disabled} onClick={() => setEditing(null)}>{t('boards.fbReport.products.cancel')}</button>
            {editing !== 'new' && <button type="button" className={`${button} text-red-600`} disabled={disabled} onClick={() => {
              onConfigChange(fbReportProductsConfig(widget.config, products.filter((p) => p.id !== editing), selected?.id === editing ? '' : selected?.id ?? ''))
              setEditing(null)
            }}>{t('boards.fbReport.products.remove')}</button>}
          </div>
        </div>
      )}
    </div>
  )
}
