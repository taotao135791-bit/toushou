import { parseGoogleVisibleDateRange, type GoogleReportContext } from '../shared/googleReport'

// Exact accessible labels only; require one visible, unobscured, enabled control.
// No scripts click elements: trusted input is sent only to the matched control.
export const buildGoogleExportLocator = (labels: string[], toolbar: boolean): string => `(() => {
 const labels = ${JSON.stringify(labels)};
 const nameOf = el => (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') || el.getAttribute('title') || el.innerText || '').trim().replace(/\\s+/g, ' ').toLowerCase();
 const roots = ${toolbar} ? Array.from(document.querySelectorAll('[role=toolbar], [aria-label], [aria-labelledby]')).filter(el => ['广告系列的主要工具条','campaigns main toolbar','campaigns primary toolbar','campaign main toolbar'].includes(nameOf(el))) : [document];
 if (roots.length !== 1) return null;
 const candidates = Array.from(roots[0].querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"]')).filter(el => {
   const r = el.getBoundingClientRect(), s = getComputedStyle(el);
   if (r.width < 4 || r.height < 4 || s.display === 'none' || s.visibility === 'hidden' || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
   const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().replace(/\\s+/g, ' ').toLowerCase();
   if (!labels.includes(name)) return false;
   const x = r.left + r.width / 2, y = r.top + r.height / 2;
   if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
   const top = document.elementFromPoint(x, y);
   return top === el || el.contains(top);
 });
 if (candidates.length !== 1) return null;
 const r = candidates[0].getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};
})()`

export interface GooglePageEvidence { accountLabels: string[]; dateLabels: string[]; currencies: string[]; timezones: string[] }
/** Interpret only explicit page evidence, never ocid or inferred locale. */
export function parseGooglePageEvidence(evidence: GooglePageEvidence): GoogleReportContext | null {
  const accounts = new Map<string, string | null>()
  for (const label of evidence.accountLabels) {
    const matches = [...label.matchAll(/\b(\d{3}-\d{3}-\d{4})\b/g)]
    for (const match of matches) {
      const id = match[1].replace(/-/g, '')
      const name = label.replace(match[1], '').replace(/[\s\n]+/g, ' ').trim() || null
      if (!accounts.has(id)) accounts.set(id, name)
    }
  }
  const dates = new Map<string, { start: string; end: string }>()
  for (const label of evidence.dateLabels) {
    const date = parseGoogleVisibleDateRange(label)
    if (date) dates.set(`${date.start}/${date.end}`, date)
  }
  const currencies = new Set(evidence.currencies)
  const timezones = new Set(evidence.timezones)
  if (accounts.size !== 1 || dates.size !== 1 || currencies.size !== 1 || timezones.size !== 1) return null
  const [accountId, accountName] = [...accounts][0]
  const date = [...dates.values()][0]
  return { accountId, accountName, currency: [...currencies][0], timezone: [...timezones][0], windowStart: date.start, windowEnd: date.end }
}

export const PAGE_EVIDENCE_SCRIPT = String.raw`(() => {
 const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden'; };
 const name = el => (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() || el.innerText || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
 const buttons = Array.from(document.querySelectorAll('button,[role=button]')).filter(visible);
 const accountLabels = buttons.filter(el => el.closest('header,[role=banner]') && el.getBoundingClientRect().top < 300).map(name).filter(n => /\b\d{3}-\d{3}-\d{4}\b/.test(n)).slice(0, 30);
 const dateLabels = buttons.map(name).filter(n => /\d{4}/.test(n) && n.length < 100).slice(0, 100);
 const bar = Array.from(document.querySelectorAll('[role=toolbar],[aria-label],[aria-labelledby]')).filter(el => ['广告系列的主要工具条','campaigns main toolbar','campaigns primary toolbar','campaign main toolbar'].includes(name(el).toLowerCase()));
 let table = bar.length === 1 ? bar[0].parentElement : null;
 while (table && table !== document.body && (!table.querySelector('table,[role=grid]') || !/GMT[+-]\d/.test(table.innerText || ''))) table = table.parentElement;
 if (table === document.body || (table && table.querySelectorAll('table,[role=grid]').length !== 1)) table = null;
 const grid = table && table.querySelector('table,[role=grid]');
 const headers = grid ? Array.from(grid.querySelectorAll('[role=columnheader],th')) : [];
 const costHeaders = headers.filter(el => /^(?:费用|花费|成本|cost)$/i.test(name(el)));
 const header = costHeaders.length === 1 ? costHeaders[0] : null;
 const headerRow = header && header.closest('[role=row],tr');
 const headerIndex = headerRow ? Array.from(headerRow.querySelectorAll('[role=columnheader],th')).indexOf(header) : -1;
 const colIndex = header && header.getAttribute('aria-colindex');
 const costCells = grid && header ? Array.from(grid.querySelectorAll('[role=row],tr')).flatMap(row => {
   const cells = Array.from(row.querySelectorAll('[role=gridcell],[role=cell],td'));
   const explicit = colIndex ? cells.filter(cell => cell.getAttribute('aria-colindex') === colIndex) : [];
   const cell = explicit.length === 1 ? explicit[0] : (headerIndex >= 0 ? cells[headerIndex] : null);
   return cell ? [cell.innerText || ''] : [];
 }) : [];
 const currencies = []; if (costCells.some(text => /(?:^|\s|\d)US\$/i.test(text))) currencies.push('USD');
 const timezones = table ? Array.from(new Set(((table.innerText || '').match(/GMT[+-]\d{1,2}(?::\d{2})?/g) || []))).slice(0, 10) : [];
 return { accountLabels, dateLabels, currencies, timezones };
})()`
