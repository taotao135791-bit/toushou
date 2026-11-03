import { describe, expect, it } from 'vitest'
import { createBoard, createWidget, validateBoard, applyMasterScope } from '../boards'
import { fbReportProducts, fbReportProductsConfig, parseFbReportProducts, selectedFbReportProduct } from '../fbReportProducts'
import { FB_REPORT_ENTRY_URL } from '../fbReportReference'

const a = { id: 'product-a', name: 'Demo A', reportName: 'Saved A', reportId: '123' }
const b = { id: 'product-b', name: 'Demo B', reportName: 'Saved B', reportId: `${FB_REPORT_ENTRY_URL}?selected_report_id=456&business_id=789` }

function persisted(config: Record<string, unknown>) {
  const board = createBoard('Demo')
  board.widgets = [{ ...createWidget('fb-report-reading', 'Demo', { x: 0, y: 0 }), config }]
  return validateBoard(board, true)?.widgets[0].config ?? null
}

describe('FB report product bindings', () => {
  it('keeps legacy report identity and reading key on migration without inventing products', () => {
    const legacy = { reportName: 'Saved A', reportId: '123', range: 'today' }
    expect(fbReportProducts(legacy, 'old-widget')).toEqual([{ ...a, id: 'old-widget', name: 'Saved A' }])
    expect(selectedFbReportProduct(legacy, 'old-widget')?.id).toBe('old-widget')
    const next = fbReportProductsConfig(legacy, [a, b], b.id)
    expect(next).not.toHaveProperty('reportName')
    expect(next).not.toHaveProperty('reportId')
    expect(persisted(next)).toEqual(next)
    expect(selectedFbReportProduct(next, 'old-widget')).toEqual(b)
  })

  it('keeps products, selection and scope across validation and master-date changes', () => {
    const widget = { ...createWidget('fb-report-reading', 'Demo', { x: 0, y: 0 }), config: { products: [a, b], selectedProductId: b.id } }
    const next = applyMasterScope(widget, { range: 'last7', metrics: ['spend'] })
    expect(persisted(next.config)).toMatchObject({ products: [a, b], selectedProductId: b.id, range: 'last7' })
    expect(persisted({ ...next.config, range: 'last3' })).toMatchObject({ range: 'last3' })
  })

  it.each(['yesterday', 'last3'] as const)('preserves the unsupported master preset guard on %s, including after saving', (range) => {
    const widget = { ...createWidget('fb-report-reading', 'Demo', { x: 0, y: 0 }), config: { products: [a, b], selectedProductId: b.id, range: 'today' } }
    const next = applyMasterScope(widget, { range, metrics: ['spend'] })
    const stored = persisted(next.config)!
    expect(stored).toMatchObject({ products: [a, b], selectedProductId: b.id, range: 'today', independent: true })
    expect(persisted(fbReportProductsConfig(stored, [a, b], a.id))).toMatchObject({ independent: true })
    const supported = applyMasterScope({ ...widget, config: stored }, { range: 'last7', metrics: ['spend'] })
    expect(persisted(supported.config)).not.toHaveProperty('independent')
    expect(persisted(supported.config)).toMatchObject({ range: 'last7' })
  })

  it('does not fall back to another product or a removed legacy binding', () => {
    const config = { products: [a, b], selectedProductId: 'missing', reportName: 'Stale' }
    expect(selectedFbReportProduct(config, 'old-widget')).toBeNull()
    expect(persisted(config)).toBeNull()
    expect(fbReportProducts({ products: [], reportName: 'Stale' }, 'old-widget')).toEqual([])
    expect(selectedFbReportProduct({ products: [a], selectedProductId: '' }, 'old-widget')).toBeNull()
  })

  it.each([
    null, {}, [null], [{ ...a, id: '../file' }], [a, a], [a, { ...b, name: ' demo a ' }],
    [{ ...a, name: '' }], [{ ...a, reportName: '' }], [{ ...a, name: 'x'.repeat(81) }],
    [{ ...a, reportId: 'https://evil.example/report' }], [{ ...a, reportId: 123 }],
    Array.from({ length: 21 }, (_, i) => ({ ...a, id: `p-${i}`, name: `Demo ${i}` }))
  ])('rejects invalid or ambiguous product bindings (%j)', (products) => {
    expect(parseFbReportProducts(products)).toBeNull()
    expect(persisted({ products })).toBeNull()
  })
})
