import { X } from 'lucide-react'
import type { CustomProviderModelSpec, RuntimeModelInfo } from '@shared/types'
import { useT } from '../i18n'

/** One wire model ID per line, optionally followed by its display name. */
export function parseModelsText(text: string): { id: string; name: string }[] {
  const seen = new Set<string>()
  const rows: { id: string; name: string }[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const gap = trimmed.search(/\s/)
    const id = gap < 0 ? trimmed : trimmed.slice(0, gap)
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ id, name: gap < 0 ? '' : trimmed.slice(gap).trim() })
  }
  return rows
}

const selectClass = 'h-8 min-w-0 rounded-lg border border-line bg-ink-850 px-2.5 text-xs text-cream focus:border-ink-600'
const contextSizes = [200_000, 256_000, 300_000, 500_000, 1_000_000]
const contextLabel = (size: number) => size === 1_000_000 ? '1M' : size % 1000 === 0 ? `${size / 1000}k` : size.toLocaleString()
const modelLine = (row: { id: string; name: string }) => row.name && row.name !== row.id ? `${row.id} ${row.name}` : row.id

export default function CustomProviderModelPicker({
  presets, savedModelIds, text, details, onText, onDetails, disabled, custom, onCustomChange
}: {
  presets: ReadonlyMap<string, RuntimeModelInfo>
  savedModelIds: ReadonlySet<string>
  text: string
  details: ReadonlyMap<string, CustomProviderModelSpec>
  onText: (value: string) => void
  onDetails: (model: CustomProviderModelSpec) => void
  disabled: boolean
  custom: boolean
  onCustomChange: (open: boolean) => void
}) {
  const t = useT()
  const selected = parseModelsText(text)
  const selectedIds = new Set(selected.map(m => m.id))
  const remaining = [...presets.values()].filter(m => !selectedIds.has(m.id))
  const manual = custom || presets.size === 0
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {presets.size > 0 && <select aria-label={t('settings.addModel')} value="" disabled={disabled || !remaining.length}
          className={selectClass} onChange={e => {
            const model = presets.get(e.target.value)
            if (model) onText([...selected, model].map(modelLine).join('\n'))
          }}>
          <option value="">{t('settings.addModel')}</option>
          {remaining.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>}
        {presets.size > 0 && <button type="button" disabled={disabled} aria-expanded={manual}
          onClick={() => onCustomChange(!manual)} className="focus-ring rounded px-1.5 py-1 text-xs text-cream-dim hover:text-cream">
          {t('settings.customModelIds')}
        </button>}
      </div>

      {manual && <label className="block space-y-1 text-xs text-cream-dim">
        <span>{t('settings.customModelIds')}</span>
        <textarea value={text} onChange={e => onText(e.target.value)} disabled={disabled} rows={3}
          placeholder={t('settings.customProviderModelsPlaceholder')}
          className="block w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 font-mono text-xs leading-5 text-cream focus:border-ink-600" />
      </label>}

      {selected.map(row => {
        const native = presets.get(row.id)
        const saved = details.get(row.id)
        const model = { ...saved, ...row }
        const savedContext = saved?.contextWindow
        const inputLabel = native?.input?.includes('image') ? t('settings.modelInputImage') : t('settings.modelInputText')
        return <div key={row.id} className="space-y-2 rounded-lg border border-line px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-cream" title={row.id}>{row.name || native?.name || row.id}</div>
              {native && <div className="mt-0.5 text-[11px] text-cream-faint">
                {[native.input?.length ? inputLabel : '', native.contextWindow ? t('settings.modelContextValue', { size: native.contextWindow.toLocaleString() }) : ''].filter(Boolean).join(' · ')}
              </div>}
            </div>
            <button type="button" className="focus-ring rounded p-1 text-cream-faint hover:text-cream" disabled={disabled}
              aria-label={t('settings.removeModel', { name: row.id })}
              onClick={() => onText(selected.filter(m => m.id !== row.id).map(modelLine).join('\n'))}><X size={13} /></button>
          </div>
          {!native?.input?.length && <label className="flex items-center justify-between gap-2 text-xs text-cream-dim">
            <span>{t('settings.modelInputLabel')}</span>
            <select disabled={disabled} className={selectClass} aria-label={t('settings.modelInput', { name: row.id })}
              value={model.input ? (model.input.includes('image') ? 'image' : 'text') : 'catalog'}
              onChange={e => onDetails({ ...model, input: e.target.value === 'catalog' ? null : e.target.value === 'image' ? ['text', 'image'] : ['text'] })}>
              <option value="catalog">{t('settings.modelRuntimeDefault')}</option>
              <option value="text">{t('settings.modelInputText')}</option>
              <option value="image">{t('settings.modelInputImage')}</option>
            </select>
          </label>}
          {!native?.contextWindow && <label className="flex items-center justify-between gap-2 text-xs text-cream-dim">
            <span>{t('settings.contextWindow')}</span>
            <select disabled={disabled} className={selectClass} required={!savedModelIds.has(row.id)} aria-label={t('settings.modelContextFor', { name: row.id })}
              value={savedContext ?? ''} onChange={e => onDetails({ ...model, contextWindow: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="" disabled={!savedModelIds.has(row.id)}>{t(savedModelIds.has(row.id) ? 'settings.modelRuntimeDefault' : 'settings.chooseModelContext')}</option>
              {savedContext && !contextSizes.includes(savedContext) && <option value={savedContext}>{contextLabel(savedContext)}</option>}
              {contextSizes.map(size => <option key={size} value={size}>{contextLabel(size)}</option>)}
            </select>
          </label>}
        </div>
      })}
    </div>
  )
}
