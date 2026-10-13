/** Saved-report references only. Never accept arbitrary browser navigation URLs. */
export const FB_REPORT_REFERENCE_LIMIT = 2000
export const FB_REPORT_ENTRY_URL = 'https://adsmanager.facebook.com/adsmanager/reporting/business_view'

export interface FbReportReference {
  reportId: string
  url?: string
}

function reportingUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'adsmanager.facebook.com' &&
      !url.username && !url.password && !url.port &&
      url.pathname === '/adsmanager/reporting/business_view' ? url : null
  } catch {
    return null
  }
}

/** Canonicalize links, retaining only the report and its explicit business/account scope. */
export function parseFbReportReference(value: unknown): FbReportReference | null {
  if (typeof value !== 'string' || value.length > FB_REPORT_REFERENCE_LIMIT) return null
  const text = value.trim()
  if (/^\d{1,32}$/.test(text)) return { reportId: text }
  const url = reportingUrl(text)
  if (!url) return null
  const clean = new URL(FB_REPORT_ENTRY_URL)
  for (const key of ['selected_report_id', 'business_id', 'act']) {
    const values = url.searchParams.getAll(key)
    if (values.length > 1) return null
    if (values.length === 0 && key !== 'selected_report_id') continue
    const id = values[0] ?? ''
    if (!(key === 'act' ? /^\d{6,20}$/ : /^\d{1,32}$/).test(id)) return null
    clean.searchParams.set(key, id)
  }
  return { reportId: clean.searchParams.get('selected_report_id')!, url: clean.href }
}

/** Without an explicit link, use the current FB context, never the v1 account registry. */
export function fbReportEntryUrl(reference: FbReportReference | null, currentUrl: string): string {
  if (reference?.url) return reference.url
  const entry = new URL(FB_REPORT_ENTRY_URL)
  try {
    const current = new URL(currentUrl)
    if (current.protocol === 'https:' && current.hostname === 'adsmanager.facebook.com' &&
        !current.username && !current.password && !current.port) {
      for (const key of ['business_id', 'act']) {
        const values = current.searchParams.getAll(key)
        if (values.length === 1 && (key === 'act' ? /^\d{6,20}$/ : /^\d{1,32}$/).test(values[0])) {
          entry.searchParams.set(key, values[0])
        }
      }
    }
  } catch {
    // A blank/non-FB panel opens the unscoped reporting entry.
  }
  if (reference) entry.searchParams.set('selected_report_id', reference.reportId)
  return entry.href
}
