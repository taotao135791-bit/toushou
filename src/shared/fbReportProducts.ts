import { parseFbReportReference } from './fbReportReference'

export const FB_REPORT_PRODUCT_LIMIT = 20

/** id is also the opaque key in Main's existing verified-reading store. */
export interface FbReportProduct {
  id: string
  name: string
  reportName: string
  reportId?: string
}

export function parseFbReportProducts(raw: unknown): FbReportProduct[] | null {
  if (!Array.isArray(raw) || raw.length > FB_REPORT_PRODUCT_LIMIT) return null
  const products: FbReportProduct[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const p = value as Record<string, unknown>
    if (typeof p.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(p.id) || ids.has(p.id)) return null
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) return null
    if (typeof p.reportName !== 'string' || !p.reportName.trim() || p.reportName.length > 80) return null
    if (p.reportId !== undefined && typeof p.reportId !== 'string') return null
    const name = p.name.trim()
    if (names.has(name.toLocaleLowerCase())) return null
    const ref = typeof p.reportId === 'string' && p.reportId.trim() ? parseFbReportReference(p.reportId) : null
    if (typeof p.reportId === 'string' && p.reportId.trim() && !ref) return null
    products.push({ id: p.id, name, reportName: p.reportName.trim(), ...(ref ? { reportId: ref.url ?? ref.reportId } : {}) })
    ids.add(p.id)
    names.add(name.toLocaleLowerCase())
  }
  return products
}

/** Legacy reports keep their original store key until their binding changes. */
export function fbReportProducts(config: Record<string, unknown>, widgetId: string): FbReportProduct[] {
  if (config.products !== undefined) return parseFbReportProducts(config.products) ?? []
  const reportName = typeof config.reportName === 'string' ? config.reportName.trim() : ''
  if (!reportName) return []
  return parseFbReportProducts([{ id: widgetId, name: reportName, reportName, reportId: config.reportId }]) ?? []
}

export function selectedFbReportProduct(config: Record<string, unknown>, widgetId: string): FbReportProduct | null {
  const products = fbReportProducts(config, widgetId)
  const selected = config.products === undefined ? widgetId : config.selectedProductId
  return products.find((p) => p.id === selected) ?? null
}

export function fbReportProductsConfig(config: Record<string, unknown>, products: FbReportProduct[], selectedProductId: string): Record<string, unknown> {
  // Drop the legacy binding after migration so it cannot resurface on deletion.
  const { reportName: _name, reportId: _id, ...rest } = config
  return { ...rest, products, selectedProductId }
}
