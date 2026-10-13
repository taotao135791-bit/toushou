// FB 报表自动导出：后台面板打开广告报告 → 定位目标报表 → 导出 CSV →
// will-download 落盘。全程只读（不点「保存」，不碰报表设置），与其它浏览
// 器动作共用一把串行锁；每一步 fail-closed，返回稳定错误码和有界现场文
// 本。页面交互全部走「脚本定位 + sendInputEvent 真实点击」——FB 关键控
// 件会过滤合成 el.click()，只有可信输入事件有效。
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { runAction, withBrowserActionLock } from './browserUse'
import { getActiveBrowserPanel, withBrowserReadingViewport } from './browserPanel'
import { FB_REPORT_FILE_LIMIT_BYTES } from './fbReportReadings'
import { FbReportFetchErrorCode, parseFbReportCsv } from '../shared/fbReportCsv'
import { boardReadingRangeDates, parseFbReadingDateRange } from '../shared/fbReading'
import { fbReportEntryUrl, parseFbReportReference } from '../shared/fbReportReference'

const DOWNLOAD_DIR_FILES_LIMIT = 20
const NAV_TIMEOUT_MS = 45_000
const PAGE_READY_TIMEOUT_MS = 25_000
const CLICK_TIMEOUT_MS = 12_000
const DIALOG_TIMEOUT_MS = 8_000
/** Counted from arming (before the 导出 click), so it also covers the dialog steps. */
const DOWNLOAD_TIMEOUT_MS = 180_000
const DETAIL_LIMIT = 300
const DIAG_LIMIT = 2_000

export interface FbReportFetchResult {
  ok: boolean
  filePath?: string
  error?: FbReportFetchErrorCode
  detail?: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const bounded = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, DETAIL_LIMIT)

// ---------------------------------------------------------------------------
// Page scripts — text-matched, bilingual, class-free, fail closed. They only
// LOCATE targets (smallest matching rect, viewport coordinates); Main clicks
// via webContents.sendInputEvent so every event is trusted input.
// ---------------------------------------------------------------------------

type LocateScope = 'document' | 'dialog' | 'overlay'

interface LocateOptions {
  /** document: whole page; dialog: visible [role=dialog|alertdialog];
   *  overlay: visible dialog/menu/listbox (export menus vs dialogs). Within
   *  a scope list, aria-modal containers are tried first, then the most
   *  recently mounted one — and only a container that actually holds a
   *  match is used, so a non-modal announcement banner can't hijack it. */
  scope?: LocateScope
  /** Allow `name.startsWith(label)` after exact matches are exhausted. */
  prefix?: boolean
  /** Only accept elements inside a button/[role=button] (dialog confirm). */
  buttonOnly?: boolean
}

/** A page-side locate script plus its not-found diagnostic twin. */
interface Locator {
  script: string
  diag: string
}

/**
 * Page-side library (plain JS, evaluated in the panel). Matching runs on
 * the ACCESSIBLE NAME — aria-label, aria-labelledby, innerText and
 * textContent (FB's visually-hidden 1px/clip label spans) — with zero-width
 * chars and all whitespace removed. The rect that gets clicked belongs to
 * the nearest clickable ancestor (button / a / role=button|link|menuitem|
 * option|tab|… / [tabindex]), not to the (possibly 1px) label span.
 *
 * Occlusion: the click point must hit the target, its subtree, or something
 * owned by the same clickable (FB layers a hover-overlay div inside every
 * button). Anything else (banner, modal backdrop, popover) means a real
 * click would land elsewhere, so the candidate is refused and reported.
 *
 * Red line: any candidate whose own or clickable-owner name is 保存/Save/
 * 另存为/Save as is never returned for clicking.
 */
const PAGE_LIB = String.raw`
const ZW = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u00ad\ufeff]/g;
const clean = (s) => String(s || "").replace(ZW, "").replace(/\s+/g, " ").trim();
const flat = (s) => clean(s).replace(/\s+/g, "");
const cut = (s, n) => clean(s).slice(0, n);
const CLICKABLE = 'button, a[href], [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=radio], [role=checkbox], [role=tab], [role=treeitem], [role=row], [role=gridcell], label, [tabindex]:not([tabindex="-1"])';
const SAVE = /^(保存|保存为|另存为|save|saveas)$/i;
const rectOf = (el) => el.getBoundingClientRect();
const visible = (el) => {
  const r = rectOf(el);
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none";
};
const nameList = (el) => {
  const out = [];
  const al = el.getAttribute("aria-label");
  if (al) out.push(al);
  const lb = el.getAttribute("aria-labelledby");
  if (lb) out.push(lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ""; }).join(" "));
  out.push(el.innerText || "");
  out.push(el.textContent || "");
  return Array.from(new Set(out.map(flat).filter((s) => s && s.length <= 240)));
};
const ownerOf = (el) => el.closest(CLICKABLE);
const clickableOf = (el) => {
  const c = ownerOf(el);
  if (!c) return el;
  const r = rectOf(c);
  return r.width <= 700 && r.height <= 160 ? c : el;
};
const isSaveEl = (el) => nameList(el).some((n) => SAVE.test(n));
const describe = (el) => {
  if (!el) return "null";
  const role = el.getAttribute && el.getAttribute("role");
  const al = el.getAttribute && el.getAttribute("aria-label");
  return el.tagName.toLowerCase() + (role ? "[" + role + "]" : "") + (al ? '"' + cut(al, 24) + '"' : "");
};
const inViewPt = (x, y) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
const probe = (target, el) => {
  const r = rectOf(target);
  // FB often lays a sibling overlay across a widget's center; sample several
  // points and accept the first whose hit passes the containment test.
  const pts = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + Math.min(8, r.width / 2), r.top + r.height / 2],
    [r.left + r.width - Math.min(8, r.width / 2), r.top + r.height / 2],
    [r.left + r.width / 2, r.top + Math.min(8, r.height / 2)],
    [r.left + r.width / 2, r.top + r.height - Math.min(8, r.height / 2)]
  ];
  let blocker = null;
  for (const [x, y] of pts) {
    if (!inViewPt(x, y)) continue;
    const h = document.elementFromPoint(x, y);
    if (!h) { blocker = blocker || "null"; continue; }
    const ho = ownerOf(h);
    // Whatever actually receives the click must never be 保存/Save.
    if (isSaveEl(h) || (ho !== null && isSaveEl(ho))) { blocker = blocker || "save:" + describe(h); continue; }
    const ok = h === target || target.contains(h) ||
      (ho !== null && (ho === ownerOf(el) || ho === target)) ||
      (ho === null && ownerOf(el) === null && h.contains(el));
    if (ok) return { inView: true, ok: true, by: null, at: [Math.round(x), Math.round(y)] };
    blocker = blocker || describe(h);
  }
  return { inView: true, ok: false, by: blocker };
};
const scopesFor = (scope) => {
  if (scope === "document") return [document];
  const sel = scope === "dialog"
    ? "[role=dialog], [role=alertdialog]"
    : "[role=dialog], [role=alertdialog], [role=menu], [role=listbox]";
  const all = Array.from(document.querySelectorAll(sel)).filter(visible);
  const modal = all.filter((d) => d.getAttribute("aria-modal") === "true");
  return modal.reverse().concat(all.filter((d) => d.getAttribute("aria-modal") !== "true").reverse());
};
const collect = (root, labels, prefix) => {
  const want = labels.map(flat).filter(Boolean);
  const maxLen = prefix ? 240 : Math.max.apply(null, want.map((w) => w.length)) + 2;
  const seen = new Set();
  const out = [];
  const consider = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    const ns = nameList(el);
    let m = 0;
    if (ns.some((n) => want.includes(n))) m = 2;
    else if (prefix && ns.some((n) => want.some((w) => n.startsWith(w)))) m = 1;
    if (m) out.push({ el, m, name: ns[0] || "" });
  };
  for (const el of root.querySelectorAll("[aria-label], [aria-labelledby]")) consider(el);
  const tw = document.createTreeWalker(root === document ? document.body : root, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!flat(n.data)) continue;
    let p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
    for (let i = 0; p && i < 6; i += 1, p = p.parentElement) {
      if (flat(p.textContent).length > maxLen) break;
      consider(p);
      if (p === root) break;
    }
  }
  return out.map((c) => {
    const target = clickableOf(c.el);
    const vis = visible(target);
    const save = isSaveEl(c.el) || isSaveEl(target) || (ownerOf(c.el) !== null && isSaveEl(ownerOf(c.el)));
    const pr = vis ? probe(target, c.el) : { inView: false, ok: false, by: null };
    return Object.assign(c, { target, vis, save, pr, r: rectOf(target) });
  });
};
const rank = (a, b) => (b.m - a.m) || ((b.pr.ok ? 1 : 0) - (a.pr.ok ? 1 : 0)) || (a.r.width * a.r.height - b.r.width * b.r.height);
// Red line + ambiguity: never click a target that holds a 保存/Save control,
// and never a non-clickable prefix container that wraps several controls
// (its centre could land on any of them).
const wrapsSave = (t) => Array.from(t.querySelectorAll(CLICKABLE)).some(isSaveEl);
const ambiguous = (c) => c.m === 1 && c.target === c.el && !c.el.matches(CLICKABLE) && c.el.querySelectorAll(CLICKABLE).length >= 2;
const usable = (c, buttonOnly) => c.vis && !c.save && !wrapsSave(c.target) && !ambiguous(c) && (!buttonOnly || c.el.closest("button, [role=button]") !== null) && (c.pr.ok || !c.pr.inView);
const finish = (c) => {
  let r = rectOf(c.target);
  if (!c.pr.inView) {
    c.target.scrollIntoView({ block: "center", inline: "center" });
    if (!probe(c.target, c.el).ok) return null;
    r = rectOf(c.target);
  }
  return { x: r.left, y: r.top, w: r.width, h: r.height, text: cut(c.name, 40) };
};
const locate = (labels, opts) => {
  for (const root of scopesFor(opts.scope || "document")) {
    const cands = collect(root, labels, Boolean(opts.prefix)).filter((c) => usable(c, opts.buttonOnly)).sort(rank);
    for (const c of cands) { const hit = finish(c); if (hit) return hit; }
  }
  return null;
};
const diagnose = (labels, opts) => {
  const scopes = scopesFor(opts.scope || "document");
  const cands = [];
  const seenTargets = new Set();
  for (const root of scopes) for (const c of collect(root, labels, Boolean(opts.prefix))) {
    if (cands.length >= 10) break;
    if (seenTargets.has(c.target)) continue;
    seenTargets.add(c.target);
    const r = c.r;
    cands.push({
      el: describe(c.el), target: describe(c.target), name: cut(c.name, 30), exact: c.m === 2,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      visible: c.vis, inView: c.pr.inView, occludedBy: c.pr.by, save: c.save
    });
  }
  const dialogs = Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")).filter(visible)
    .slice(-5).map((d) => describe(d) + (d.getAttribute("aria-modal") === "true" ? "(modal)" : "") + ":" + cut(d.innerText, 30));
  return { scope: opts.scope || "document", scopes: scopes.length, view: [innerWidth, innerHeight], overlays: dialogs, candidates: cands };
};
const caretCands = () => {
  const saves = collect(document, ["保存", "Save"], false).filter((c) => c.vis && c.target !== c.el);
  const carets = collect(document, CARET_LABELS, false).filter((c) => c.vis && !c.save);
  const pairs = [];
  for (const s of saves) {
    const sr = rectOf(s.target);
    for (const c of carets) {
      if (c.target === s.target || s.target.contains(c.target) || c.target.contains(s.target)) continue;
      const r = c.r;
      const sameRow = Math.abs((r.top + r.height / 2) - (sr.top + sr.height / 2)) <= sr.height / 2;
      const gap = r.left - sr.right;
      if (sameRow && gap >= -6 && gap <= 24) pairs.push({ s, c, gap });
    }
    // Fallback: probe right of the whole 保存 button for a different button.
    for (const dx of [3, 8, 14, 20]) {
      const x = sr.right + dx;
      const y = sr.top + sr.height / 2;
      if (!inViewPt(x, y)) continue;
      const h = document.elementFromPoint(x, y);
      const b = h && h.closest('button, [role=button], [aria-haspopup]');
      if (!b || b === s.target || s.target.contains(b) || b.contains(s.target) || isSaveEl(b)) continue;
      const r = rectOf(b);
      if (r.width < 4 || r.height < 4 || r.left < sr.right - 6) continue;
      pairs.push({ s, c: { el: b, target: b, vis: true, save: false, pr: probe(b, b), r, name: "caret(probe)" }, gap: r.left - sr.right + 0.5 });
      break;
    }
  }
  return { saves, carets, pairs: pairs.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap)) };
};
`

const CARET_LABELS = ['打开下拉菜单', 'Open dropdown menu', 'Open drop-down menu', 'More options', '更多选项']

const pageCall = (body: string): string =>
  '(() => {' + PAGE_LIB + 'const CARET_LABELS = ' + JSON.stringify(CARET_LABELS) + ';' + body + '})()'

const locator = (labels: readonly string[], options: LocateOptions = {}): Locator => {
  const args = JSON.stringify(labels) + ', ' + JSON.stringify(options)
  return { script: pageCall('return locate(' + args + ');'), diag: pageCall('return diagnose(' + args + ');') }
}

// Toolbar 导出 ONLY: the closed export dialog leaves a shadow node whose own
// 导出 confirm button (28x20) is smaller than the toolbar button and would
// win the smallest-rect ranking. Dialog-internal candidates are excluded —
// the dialog's 导出 is LOCATE_CONFIRM's job, not this one's.
const LOCATE_EXPORT: Locator = {
  script: pageCall(
    // Icon-only toolbar: the button has NO text — 导出 lives in aria-label /
    // title (hover tooltip). Try text first, then labelled buttons.
    'let cands = collect(document, ["导出", "Export"], false)' +
    '  .filter((c) => !c.el.closest("[role=dialog], [role=alertdialog]"));' +
    'let usableCands = cands.filter((c) => usable(c, true)).sort(rank);' +
    'if (!usableCands.length) {' +
    '  const labelled = [];' +
    '  for (const el of document.querySelectorAll("[aria-label], [title]")) {' +
    '    const label = flat(el.getAttribute("aria-label") || el.getAttribute("title") || "");' +
    '    if (label !== "导出" && label !== "Export") continue;' +
    '    if (el.closest("[role=dialog], [role=alertdialog]")) continue;' +
    '    const r = el.getBoundingClientRect();' +
    '    if (r.width < 4 || r.height < 4) continue;' +
    '    labelled.push({ el, target: el, name: label, r, vis: true, save: false, pr: probe(el, el) });' +
    '  }' +
    '  usableCands = labelled.filter((c) => usable(c, true)).sort(rank);' +
    '}' +
    'const c = usableCands[0];' +
    'if (!c) return null;' +
    'const r = rectOf(c.target);' +
    'return { x: r.left, y: r.top, w: r.width, h: r.height, text: cut(c.name, 24) };'
  ),
  diag: pageCall(
    'const all = collect(document, ["导出", "Export"], false);' +
    'return { total: all.length, inDialog: all.filter((c) => c.el.closest("[role=dialog], [role=alertdialog]")).length };'
  )
}

/** Focuses the toolbar 导出 (same candidate logic as LOCATE_EXPORT) so a
 *  Return keypress can activate it through the focus pipeline. */
const FOCUS_EXPORT_SCRIPT = pageCall(
  'let cands = collect(document, ["导出", "Export"], false)' +
    '  .filter((c) => !c.el.closest("[role=dialog], [role=alertdialog]"));' +
  'let usableCands = cands.filter((c) => usable(c, true)).sort(rank);' +
  'if (!usableCands.length) {' +
  '  const labelled = [];' +
  '  for (const el of document.querySelectorAll("[aria-label], [title]")) {' +
  '    const label = flat(el.getAttribute("aria-label") || el.getAttribute("title") || "");' +
  '    if (label !== "导出" && label !== "Export") continue;' +
  '    if (el.closest("[role=dialog], [role=alertdialog]")) continue;' +
  '    const r = el.getBoundingClientRect();' +
  '    if (r.width < 4 || r.height < 4) continue;' +
  '    labelled.push({ el, target: el, name: label, r, vis: true, save: false, pr: probe(el, el) });' +
  '  }' +
  '  usableCands = labelled.filter((c) => usable(c, true)).sort(rank);' +
  '}' +
  'const c = usableCands[0];' +
  'if (!c) return null;' +
  '(c.el.closest("button, [role=button]") || c.el).focus();' +
  'const r = rectOf(c.target);' +
  'return { x: r.left, y: r.top };'
)
/** Ads Manager-style export: 导出 opens a menu whose item opens the dialog. */
const LOCATE_EXPORT_TABLE_DATA = locator(
  ['导出表格数据', 'Export table data', '导出表格数据…', 'Export table data…', '导出表格数据...', 'Export table data...',
   '导出报告', 'Export report', '导出报告…', 'Export report…', '导出报告...', 'Export report...'],
  { scope: 'overlay', prefix: true }
)
const LOCATE_CSV = locator(
  ['.csv', 'CSV', 'csv', 'CSV (.csv)', '.CSV', '逗号分隔', 'Comma-separated', 'Comma separated',
    '导出为 CSV', '导出为 .csv', '导出 CSV', 'Export as CSV', 'Export as .csv', 'Export CSV'],
  { scope: 'overlay', prefix: true }
)
const LOCATE_CONFIRM = locator(['导出', '下载', 'Export', 'Download', '确认', 'Confirm'], {
  scope: 'dialog',
  buttonOnly: true
})
const locateReportByName = (name: string): Locator => locator([name], { prefix: true })

/** Navigation guard: leaving the scratch 无标题报告 pops 要保存…更改吗？ —
 *  discard it (不保存). We NEVER click 保存; the scratch state is residue
 *  of automated visits, saved reports are not touched. */
const LOCATE_DONT_SAVE = locator(
  ['不保存', "Don't save", '放弃更改', 'Discard changes'],
  { scope: 'dialog', buttonOnly: true }
)

/** Reads the 导出内容名称 field inside the export dialog and flat-compares
 *  it with the configured report name — the deep-link view usually IS the
 *  target report, and this verifies it without opening anything. */
async function exportDialogNames(reportName: string): Promise<boolean> {
  const panel = getActiveBrowserPanel()
  if (!panel || panel.webContents.isDestroyed()) return false
  const script = pageCall(
    'const exportDialogs = Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog]"))' +
    '.filter(visible).filter((el) => /csv|xlsx|逗号分隔|comma/i.test(el.innerText || ""));' +
    'const want = flat(' + JSON.stringify(reportName) + ');' +
    'return exportDialogs.some((dlg) => Array.from(dlg.querySelectorAll("input, [contenteditable]"))' +
    '.some((input) => {' +
    '  let name = flat(String(input.value ?? input.textContent ?? ""));' +
    '  if (name.toLowerCase().endsWith(".csv")) name = name.slice(0, -4);' +
    '  return name === want;' +
    '}));'
  )
  try {
    return (await panel.webContents.executeJavaScript(script, true)) === true
  } catch {
    return false
  }
}

const LIST_READY_SCRIPT = `(() => {
  const text = (document.body.innerText || '').slice(0, 2500)
  const bad = /无法显示内容|链接可能已过期|isn't available|link may have expired/i.test(text)
  const create = /创建报告|Create report/.test(text)
  const visited = /上次访问|Last accessed|编辑时间|Edited/.test(text)
  const header = /所有报告|All reports|报告名称|Report name/.test(text)
  return !bad && (create || visited || header) ? true : null
})()`

/** An export menu/dialog is open — content-checked so a non-modal banner
 *  (e.g. 「关于本次更新 关闭」) never counts as the export dialog. */
const OVERLAY_PRESENT_SCRIPT = pageCall(
  'return Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")).filter(visible)' +
    '.some((d) => /csv|xlsx|导出|export|下载|download/i.test(flat(d.innerText)));'
)
/** The format chooser dialog itself is up. */
const DIALOG_PRESENT_SCRIPT = pageCall(
  'return Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog]")).filter(visible)' +
    '.some((d) => /csv|xlsx|逗号分隔|comma/i.test(flat(d.innerText)));'
)

// --- Date range selection -------------------------------------------------

/** FB quick-range labels per fetch range. 近3天 has no FB quick option. */
const RANGE_LABELS: Record<string, string[]> = {
  today: ['今天', 'Today'],
  last7: ['过去 7 天', '过去7天', 'Past 7 days', 'Last 7 days'],
  last30: ['过去 30 天', '过去30天', 'Past 30 days', 'Last 30 days']
}

/** Date-picker script: finds a button whose text contains 天, a colon,
 *  and a digit (e.g. "过去 14 天：9月26日 – 10月9日") — pure string test,
 *  no regex (the TS → page-script escaping chain eats backslashes). */
const DATE_PICKER_JS =
  '(() => {' +
  'let best=null;let bestArea=Infinity;let bestText="";' +
  'for(const el of document.querySelectorAll("button,[role=button],[role=combobox]")){' +
  'const t=(el.innerText||"").split(" ").filter(Boolean).join(" ").trim();' +
  'if(!t||t.length<8||t.length>120)continue;' +
  'if(!t.includes("\u5929")&&!t.toLowerCase().includes("day"))continue;' +
  'if(!t.includes(":")&&!t.includes("\uFF1A"))continue;' +
  'let hasNum=false;for(const c of t){if(c>="0"&&c<="9"){hasNum=true;break;}}' +
  'if(!hasNum)continue;' +
  'const r=el.getBoundingClientRect();' +
  'if(r.width<40||r.height<16)continue;' +
  'const a=r.width*r.height;' +
  'if(a<bestArea){best=r;bestArea=a;bestText=t;}}' +
  'if(!best)return null;' +
  'return{x:best.x,y:best.y,w:best.width,h:best.height,text:bestText.slice(0,40)};' +
  '})()'

/** Locates the date-range picker button on the report toolbar (shows the
 *  current range like "过去 14 天：…"). */
const LOCATE_DATE_PICKER: Locator = {
  script: DATE_PICKER_JS,
  diag: DATE_PICKER_JS
}

/** Locates a quick-range option — the FB date popover is a plain positioned
 *  div (NOT [role=dialog/menu]), so search the whole document. */
const locateQuickRange = (labels: readonly string[]): Locator => locator(labels, {})

/** Locates the 更新/Update button inside the date popover. */
const LOCATE_DATE_UPDATE = locator(['更新', 'Update', 'Apply', '确定', 'OK'], {
  buttonOnly: true
})

type ReportWindow = { start: string; end: string }

const DATE_LABELS_SCRIPT = pageCall(
  'return Array.from(document.querySelectorAll("button, [role=button], [role=combobox]"))' +
  '.filter(visible).map((el) => clean(el.innerText || el.getAttribute("aria-label") || ""));'
)

async function reportDateMatches(expected: ReportWindow): Promise<boolean> {
  const panel = getActiveBrowserPanel()
  if (!panel || panel.webContents.isDestroyed()) return false
  const labels: unknown = await panel.webContents.executeJavaScript(DATE_LABELS_SCRIPT, true).catch(() => null)
  return Array.isArray(labels) && labels.some((label: unknown) => {
    if (typeof label !== 'string') return false
    const actual = parseFbReadingDateRange(label)
    return actual?.start === expected.start && actual.end === expected.end
  })
}

/** Quick presets may apply immediately, without an Update button. Never
 * export the saved window when the requested window could not be applied. */
async function setReportDateRange(range: FbReportFetchRange, expected: ReportWindow): Promise<void> {
  log('set-date-range', { range, ...expected })
  await sleep(1_000)
  if (!(await realClick(LOCATE_DATE_PICKER, 6_000, 'date-picker'))) {
    throw new Error('未找到报表日期选择器，本次获取已停止。')
  }
  if (!(await realClick(locateQuickRange(RANGE_LABELS[range]), 6_000, 'quick-range'))) {
    await pressEscape()
    throw new Error('未找到所选日期范围，本次获取已停止。')
  }
  await sleep(700)
  if (!(await reportDateMatches(expected))) {
    await realClick(LOCATE_DATE_UPDATE, 2_000, 'date-update')
  }
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await reportDateMatches(expected)) {
      // Give the data refresh time to start before inspecting loading state.
      await sleep(1_000)
      const ready = await poll(pageCall(
        'return !Array.from(document.querySelectorAll("[role=progressbar], [aria-busy=true]"))' +
        '.some(visible);'
      ), PAGE_READY_TIMEOUT_MS, 500)
      if (ready === true) {
        log('date-range verified', expected)
        return
      }
      break
    }
    await sleep(500)
  }
  throw new Error('报表未切换到所选日期范围，本次获取已停止。')
}

function targetReportScript(reportName: string, reportId?: string): string {
  return pageCall(
    'const want = flat(' + JSON.stringify(reportName) + ');' +
    'const expectedId = ' + JSON.stringify(reportId ?? '') + ';' +
    'if (expectedId && new URL(location.href).searchParams.get("selected_report_id") !== expectedId) return false;' +
    'return Array.from(document.querySelectorAll("h1, [role=heading]"))' +
    '.filter(visible).filter((el) => flat(el.textContent) === want).length === 1;'
  )
}

const SNIPPET_SCRIPT = '((document.body.innerText || "").replace(/\\s+/g, " ")).slice(0, 300)'

// ---------------------------------------------------------------------------
// Download wiring
// ---------------------------------------------------------------------------

function downloadsDir(): string {
  const dir = path.join(app.getPath('userData'), 'fb-report-downloads')
  mkdirSync(dir, { recursive: true })
  try {
    const files = readdirSync(dir)
      .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const stale of files.slice(DOWNLOAD_DIR_FILES_LIMIT)) {
      try {
        unlinkSync(path.join(dir, stale.name))
      } catch {
        // best-effort cleanup
      }
    }
  } catch {
    // best-effort cleanup
  }
  return dir
}

// ---------------------------------------------------------------------------
// Permanent download interception on the panel session — a manual click in
// the visible browser panel must never pop a native save dialog either.
// ---------------------------------------------------------------------------

let panelSessionWired = false

/** Wires a persistent will-download handler on the panel session: every
 *  download (manual or automated) lands in userData/fb-report-downloads
 *  with a deduplicated name — no save dialog, no replace prompt. */
function wirePanelDownloadInterception(session: Electron.Session): void {
  if (panelSessionWired) return
  panelSessionWired = true
  const dir = downloadsDir()
  session.setDownloadPath(dir)
  session.on('will-download', (_event, item) => {
    const safeName = Date.now() + '-' + item.getFilename().replace(/[^\w.-]+/g, '_').slice(-80)
    item.setSavePath(path.join(dir, safeName))
  })
}

/** Completes an export whose format dialog is ALREADY open: pick CSV,
 *  confirm, await the armed download. Shared by the fast path (probe dialog
 *  stays open) and step 4 (dialog opened by its own click). */
async function finishExport(download: ReturnType<typeof armDownload>): Promise<FbReportFetchResult> {
  const csvClicked = download.started() || (await realClick(LOCATE_CSV, CLICK_TIMEOUT_MS, 'csv'))
  if (!csvClicked && !download.started()) {
    log('csv-option-not-found')
    return { ok: false, error: 'csv-option-not-found', detail: await pageSnippet() }
  }
  await sleep(800)
  if (!download.started()) {
    const confirmed = await realClick(LOCATE_CONFIRM, CLICK_TIMEOUT_MS, 'confirm')
    if (!confirmed && !download.started()) {
      log('confirm-not-found')
      return { ok: false, error: 'csv-option-not-found', detail: 'confirm-not-found | ' + (await pageSnippet()) }
    }
  }
  try {
    const filePath = await download.done
    log('download done')
    return { ok: true, filePath }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'download-failed'
    log(message)
    if (message === 'download-timeout') {
      const processing = await poll(pageCall(
        'return Array.from(document.querySelectorAll("[role=heading], h1, h2, h3, h4"))' +
        '.filter(visible).some((el) => /正在创建导出|正在处理|creating.*export|processing/i.test(el.textContent || ""));'
      ), 500, 250)
      return { ok: false, error: 'download-timeout', detail: processing === true
        ? 'FB 仍在生成本次 CSV，等待期间尚未就绪，旧数据已保留。'
        : '等待本次 CSV 下载超时，旧数据已保留。' }
    }
    return { ok: false, error: 'download-failed', detail: bounded(message) }
  }
}

interface DownloadWaiter {
  /** Resolves with the saved path; rejects download-timeout / download-<state>. */
  done: Promise<string>
  /** True once will-download fired (the export started without a confirm). */
  started(): boolean
  /** Detach the listener and settle quietly (no unhandled rejection). */
  cancel(): void
}

/**
 * Arms a one-shot download waiter on the panel session. Armed BEFORE the
 * export click: some FB variants start the download straight from the CSV
 * menu item, and an unclaimed will-download on a session without a save
 * path pops a native Save-As dialog. Does NOT change the session's default
 * download path (the user's own panel downloads keep their location).
 */
function armDownload(session: Electron.Session, dir: string, reportName: string): DownloadWaiter {
  const normalizeName = (name: string): string => name.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '').replace(/\s+/g, '')
  const expectedName = normalizeName(reportName)
  let settled = false
  let started = false
  let cancel: () => void = () => undefined
  const done = new Promise<string>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      session.removeListener('will-download', onWillDownload)
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('download-timeout'))), DOWNLOAD_TIMEOUT_MS)
    const onWillDownload = (_event: unknown, item: Electron.DownloadItem): void => {
      const original = item.getFilename()
      if (started || !/\.csv$/i.test(original) || normalizeName(original.slice(0, -4)) !== expectedName) return
      started = true
      const safeName = 'fb-report-' + Date.now() + '-' + original.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_').slice(-80)
      const target = path.join(dir, safeName)
      item.setSavePath(target)
      log('download started', { file: bounded(original), mime: item.getMimeType(), bytes: item.getTotalBytes() })
      item.once('done', (_e, state) => {
        if (state === 'completed') finish(() => resolve(target))
        else finish(() => reject(new Error('download-' + state)))
      })
    }
    cancel = () => finish(() => reject(new Error('download-cancelled')))
    session.on('will-download', onWillDownload)
  })
  // The waiter may be abandoned on an early fail-closed return.
  done.catch(() => undefined)
  return { done, started: () => started, cancel }
}

const log = (step: string, extra?: Record<string, unknown>): void => {
  console.info('[fb-report-auto-fetch] ' + step + (extra ? ' ' + JSON.stringify(extra) : ''))
}

// ---------------------------------------------------------------------------
// Panel helpers
// ---------------------------------------------------------------------------

async function poll(script: string, timeoutMs: number, intervalMs = 1_500): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      last = await getActiveBrowserPanel()?.webContents.executeJavaScript(script, true)
    } catch {
      last = null
    }
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

/** Not-found evidence: the candidates the locator saw and why each was
 *  refused (size/visibility/occlusion/save). Bounded; no ids or URLs. */
async function logDiagnosis(target: Locator, label: string): Promise<void> {
  try {
    const panel = getActiveBrowserPanel()
    if (!panel || panel.webContents.isDestroyed()) return
    const diag: unknown = await panel.webContents.executeJavaScript(target.diag, true)
    console.info('[fb-report-auto-fetch] diag ' + label + ' ' + JSON.stringify(diag).slice(0, DIAG_LIMIT))
  } catch (error) {
    log('diag ' + label + ' failed', { message: bounded(error instanceof Error ? error.message : String(error)) })
  }
}

/** Trusted-input click on a located rect (see locator). */
async function realClick(target: Locator, timeoutMs: number, label: string, intervalMs = 800): Promise<boolean> {
  const locateScript = target.script
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const panel = getActiveBrowserPanel()
    if (panel && !panel.webContents.isDestroyed()) {
      const rect = await panel.webContents.executeJavaScript(locateScript, true).catch(() => null)
      if (rect && typeof rect === 'object' && typeof (rect as { x?: unknown }).x === 'number') {
        const box = rect as { x: number; y: number; w: number; h: number; text?: string }
        // getBoundingClientRect is CSS px; sendInputEvent takes DIP relative
        // to the view. They differ only by page zoom (DPR is already folded
        // into DIP), so scale by the zoom factor.
        const zoom = panel.webContents.getZoomFactor() || 1
        const x = Math.round((box.x + box.w / 2) * zoom)
        const y = Math.round((box.y + box.h / 2) * zoom)
        const bounds = panel.getBounds()
        log('click ' + label, { x, y, w: Math.round(box.w), h: Math.round(box.h), text: box.text ?? '', view: bounds.width + 'x' + bounds.height })
        if (panel.webContents.isDestroyed()) return false
        panel.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        await sleep(200)
        // The reporting banner mounts asynchronously and moves the toolbar.
        // Re-locate after hover; stale coordinates can open the business
        // selector instead of the date picker. Never press at a moved rect.
        if (panel.webContents.isDestroyed()) return false
        const current: unknown = await panel.webContents.executeJavaScript(locateScript, true).catch(() => null)
        const latest = current as typeof box | null
        if (!latest || Math.abs(latest.x - box.x) > 1 || Math.abs(latest.y - box.y) > 1 ||
            Math.abs(latest.w - box.w) > 1 || Math.abs(latest.h - box.h) > 1) {
          log('layout changed before click ' + label)
          continue
        }
        panel.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        panel.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        await sleep(60)
        if (panel.webContents.isDestroyed()) return false
        panel.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        return true
      }
    }
    await sleep(intervalMs)
  }
  log('not found ' + label)
  await logDiagnosis(target, label)
  return false
}

async function pressEscape(): Promise<void> {
  const panel = getActiveBrowserPanel()
  if (!panel || panel.webContents.isDestroyed()) return
  panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await sleep(400)
}

async function pressReturn(): Promise<void> {
  const panel = getActiveBrowserPanel()
  if (!panel || panel.webContents.isDestroyed()) return
  panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await sleep(400)
}

/** Activates a located button via keyboard: focus it, then press Return.
 *  FB intermittently drops injected MOUSE events on the toolbar 导出 (DOM
 *  hit-test passes but nothing opens); the keyboard path goes through the
 *  focus pipeline instead and sidesteps that entirely. */
async function activateByKeyboard(timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const panel = getActiveBrowserPanel()
    if (panel && !panel.webContents.isDestroyed()) {
      const rect = await panel.webContents.executeJavaScript(FOCUS_EXPORT_SCRIPT, true).catch(() => null)
      if (rect && typeof rect === 'object' && typeof (rect as { x?: unknown }).x === 'number') {
        log('key-activate ' + label, { x: Math.round((rect as { x: number }).x) })
        await pressReturn()
        return true
      }
    }
    await sleep(800)
  }
  return false
}

async function panelUrl(): Promise<string> {
  const panel = getActiveBrowserPanel()
  if (!panel || panel.webContents.isDestroyed()) return ''
  return panel.webContents.getURL()
}

async function pageSnippet(): Promise<string> {
  try {
    const text = await getActiveBrowserPanel()?.webContents.executeJavaScript(SNIPPET_SCRIPT, true)
    return bounded(typeof text === 'string' ? text : '')
  } catch {
    return ''
  }
}

const LOGIN_URL = /login\.(facebook|business\.facebook)\.com|\/login/i

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export type FbReportFetchRange = 'today' | 'last7' | 'last30'

export function autoFetchFbReportCsv(reportName: string, reportId?: string, range?: FbReportFetchRange): Promise<FbReportFetchResult> {
  return withBrowserActionLock<FbReportFetchResult>(async () => {
    const reference = reportId === undefined ? null : parseFbReportReference(reportId)
    if (reportId !== undefined && !reference) {
      return { ok: false, error: 'fetch-failed', detail: '报表 ID 或链接无效，请复制 FB 已保存报表的完整链接。' }
    }
    const dir = downloadsDir()
    const initialPanel = getActiveBrowserPanel()
    if (initialPanel && !initialPanel.webContents.isDestroyed()) {
      wirePanelDownloadInterception(initialPanel.webContents.session)
    }
    const navigate = async (url: string): Promise<void> => {
      try {
        await runAction({
          action: 'navigate',
          url,
          keepRoute: true,
          // Visible panel, not the 0x0 background surface: the renderer
          // attaches the panel via PANEL_OPEN, so every sendInputEvent
          // coordinate lands on a real viewport (the user watches the run).
          background: false,
          navTimeoutMs: NAV_TIMEOUT_MS
        })
      } catch {
        // redirect chains can abort the measured load yet still land
      }
    }

    // Explicit report link wins. Legacy numeric/name references use the
    // current FB context, never another module's first registered account.
    const entryUrl = fbReportEntryUrl(reference, await panelUrl())
    const entry = new URL(entryUrl)
    log('start', { report: bounded(reportName), act: entry.searchParams.has('act'),
      business: entry.searchParams.has('business_id'), explicitLink: Boolean(reference?.url) })
    await navigate(entryUrl)
    const url = await panelUrl()
    if (!url) return { ok: false, error: 'panel-not-open' }
    if (LOGIN_URL.test(url)) {
      log('login-required')
      return { ok: false, error: 'login-required', detail: bounded(url) }
    }
    // PANEL_OPEN attaches the panel asynchronously on the renderer side —
    // wait for real bounds before touching coordinates.
    for (let i = 0; i < 20; i += 1) {
      const view = getActiveBrowserPanel()
      if (view && !view.webContents.isDestroyed()) {
        const bounds = view.getBounds()
        if (bounds.width >= 200 && bounds.height >= 200) break
      }
      await sleep(500)
    }
    // The hidden background panel sits at a 0x0 layout until something
    // stretches it — without a real viewport every coordinate click (trusted
    // or synthetic) lands on nothing. Wrap the interactions in the same
    // reading-viewport stretch the FB reading pipeline uses.
    const activePanel = getActiveBrowserPanel()
    if (!activePanel || activePanel.webContents.isDestroyed()) {
      return { ok: false, error: 'panel-not-open' }
    }
    // FB's export popover gates on document focus: when the OS window is in
    // the background every activation (mouse AND keyboard) is silently
    // ignored. Focus the window and the panel contents before interacting.
    const focusWindow = BrowserWindow.fromWebContents(activePanel.webContents)
    if (focusWindow && !focusWindow.isDestroyed()) {
      try {
        if (focusWindow.isMinimized()) focusWindow.restore()
        focusWindow.focus()
      } catch {
        // best-effort
      }
    }
    try {
      activePanel.webContents.focus()
    } catch {
      // best-effort
    }
    return await withBrowserReadingViewport(activePanel, async (): Promise<FbReportFetchResult> => {
      const vb = activePanel.getBounds()
      log('viewport', { w: vb.width, h: vb.height, zoom: activePanel.webContents.getZoomFactor() })

      // Verify the saved report first. A deep link can land on an untitled
      // scratch report; that surface must never be exported as the target.
      if ((await poll(LIST_READY_SCRIPT, PAGE_READY_TIMEOUT_MS, 500)) !== true) {
        return { ok: false, error: 'navigation-failed', detail: await pageSnippet() }
      }
      const target = targetReportScript(reportName, reference?.reportId)
      if ((await poll(target, 2_000, 500)) !== true) {
        const savedList = locator(['创建报告', 'Create report'], { buttonOnly: true })
        // An unscoped entry can already be the list, where All reports
        // does not exist. Do not require a navigation control in that case.
        if (!(await poll(savedList.script, 700, 350))) {
          const allReports = locator(['所有报告', 'All reports'], { buttonOnly: true })
          if (!(await realClick(allReports, 6_000, 'all-reports'))) {
            return { ok: false, error: 'report-not-found', detail: '未能打开已保存报表列表。' }
          }
          // Only discard the current unsaved reporting view; never save it.
          await realClick(LOCATE_DONT_SAVE, DIALOG_TIMEOUT_MS, 'discard-report-view')
        }
        if (!(await poll(savedList.script, PAGE_READY_TIMEOUT_MS, 500))) {
          return { ok: false, error: 'report-not-found', detail: '已保存报表列表尚未加载完成。' }
        }
        // The template sidebar can cover the report list in a narrow panel.
        await realClick(locator(['关闭侧边面板', 'Close side panel']), 1_000, 'close-template-sidebar')
        // Identify the actual saved-report anchor. FB's click handler
        // loads saved configuration; loading its URL alone can open an
        // untitled scratch report. Keyboard activation also avoids row
        // selection when the anchor is clipped in a narrow list.
        const link: unknown = await activePanel.webContents.executeJavaScript(pageCall(
          'const want = flat(' + JSON.stringify(reportName) + ');' +
          'const expectedId = ' + JSON.stringify(reference?.reportId ?? '') + ';' +
          'const matches = Array.from(document.querySelectorAll("a[href]"))' +
          '.filter((el) => nameList(el).some((name) => name === want))' +
          '.filter((el) => { try { return !expectedId || new URL(el.href).searchParams.get("selected_report_id") === expectedId; } catch { return false; } });' +
          'const urls = [...new Set(matches.map((el) => el.href))];' +
          'return urls.length === 1 ? urls[0] : urls.length > 1 ? "ambiguous-report" : null;'
        ), true).catch(() => null)
        if (link === 'ambiguous-report' || (reference && typeof link !== 'string')) {
          return { ok: false, error: 'report-not-found', detail: '未找到唯一匹配的报表，请检查完整报表链接及访问权限。' }
        }
        let opened = false
        if (typeof link === 'string') {
          const saved = new URL(link)
          if (saved.protocol === 'https:' && saved.hostname === 'adsmanager.facebook.com' &&
              saved.pathname === '/adsmanager/reporting/business_view' &&
              !saved.username && !saved.password && !saved.port &&
              /^\d{1,32}$/.test(saved.searchParams.get('selected_report_id') || '') &&
              (!reference || saved.searchParams.get('selected_report_id') === reference.reportId)) {
            activePanel.webContents.focus()
            const focused: unknown = await activePanel.webContents.executeJavaScript(pageCall(
              'const href = ' + JSON.stringify(saved.href) + ';' +
              'const anchor = Array.from(document.querySelectorAll("a[href]"))' +
              '.find((el) => el.href === href);' +
              'if (!anchor) return false;' +
              'anchor.scrollIntoView({ block: "nearest", inline: "nearest" });' +
              'anchor.focus(); return document.activeElement === anchor;'
            ), true).catch(() => false)
            if (focused === true) {
              log('activate saved-report link')
              await pressReturn()
              opened = true
            }
          } else {
            return { ok: false, error: 'report-not-found', detail: '报表列表中的链接不属于有效的 FB 已保存报表。' }
          }
        }
        if (!opened) opened = await realClick(locateReportByName(reportName), 6_000, 'saved-report')
        if (!opened || (await poll(target, PAGE_READY_TIMEOUT_MS, 500)) !== true) {
          return { ok: false, error: 'report-not-found', detail: '未能确认已打开指定的已保存报表。' }
        }
      }
      log('target-report verified')
      const expected = range ? boardReadingRangeDates(range) : undefined
      if (range && expected) await setReportDateRange(range, expected)
      // The report heading must still match after the date update.
      if ((await poll(target, 1_000, 500)) !== true) {
        return { ok: false, error: 'report-not-found', detail: '日期切换后报表身份发生变化。' }
      }

      const panel = getActiveBrowserPanel()
      if (!panel || panel.webContents.isDestroyed()) return { ok: false, error: 'panel-not-open' }
      const download = armDownload(panel.webContents.session, dir, reportName)
      try {
        const exportClicked = await realClick(LOCATE_EXPORT, 6_000, 'export')
        if (!exportClicked) {
          log('export-button-not-found')
          return { ok: false, error: 'export-button-not-found', detail: await pageSnippet() }
        }
        let overlay = await poll(OVERLAY_PRESENT_SCRIPT, DIALOG_TIMEOUT_MS, 700)
        if (overlay !== true && !download.started()) {
          await activateByKeyboard(2_000, 'export-keyboard')
          overlay = await poll(OVERLAY_PRESENT_SCRIPT, DIALOG_TIMEOUT_MS, 700)
        }
        if (overlay !== true && !download.started()) {
          log('export-button-not-found (no dialog/menu after click)')
          return { ok: false, error: 'export-button-not-found', detail: await pageSnippet() }
        }
        // Menu variant: 导出 ▾ → 导出表格数据… → dialog. Absent in the
        // direct-dialog variant, so a short look is enough.
        if (!download.started() && (await poll(DIALOG_PRESENT_SCRIPT, 700, 700)) !== true) {
          if (await realClick(LOCATE_EXPORT_TABLE_DATA, 3_000, 'export-table-data')) {
            await poll(DIALOG_PRESENT_SCRIPT, DIALOG_TIMEOUT_MS, 700)
          }
        }
        if (!download.started() && !(await exportDialogNames(reportName))) {
          await pressEscape()
          return { ok: false, error: 'report-not-found', detail: '导出对话框中的报表名称与目标不一致。' }
        }
        const result = await finishExport(download)
        if (result.ok && result.filePath && expected) {
          if (statSync(result.filePath).size > FB_REPORT_FILE_LIMIT_BYTES) {
            return { ok: false, error: 'fetch-failed', detail: '下载文件超过大小限制，旧数据已保留。' }
          }
          const outcome = parseFbReportCsv(readFileSync(result.filePath, 'utf8'))
          const actual = outcome.summary
          if (!outcome.verification.verified || actual?.windowStart !== expected.start || actual.windowEnd !== expected.end) {
            log('download verification failed', { expected, start: actual?.windowStart, end: actual?.windowEnd })
            return { ok: false, error: 'fetch-failed', detail: '下载文件未通过数据或日期校验，旧数据已保留。' }
          }
        }
        return result
      } finally {
        download.cancel()
      }
    })
  }).catch((error: unknown): FbReportFetchResult => {
    log('fetch-failed', { message: bounded(error instanceof Error ? error.message : String(error)) })
    return {
      ok: false,
      error: 'fetch-failed',
      detail: bounded(error instanceof Error ? error.message : String(error))
    }
  })
}
