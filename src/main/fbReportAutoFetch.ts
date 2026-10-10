// FB 报表自动导出：后台面板打开广告报告 → 定位目标报表 → 导出 CSV →
// will-download 落盘。全程只读（不点「保存」，不碰报表设置），与其它浏览
// 器动作共用一把串行锁；每一步 fail-closed，返回稳定错误码和有界现场文
// 本。页面交互全部走「脚本定位 + sendInputEvent 真实点击」——FB 关键控
// 件会过滤合成 el.click()，只有可信输入事件有效。
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { runAction, withBrowserActionLock } from './browserUse'
import { getActiveBrowserPanel, hideBrowserPanel, withBrowserReadingViewport } from './browserPanel'
import { listFbReadingAccounts } from './fbReadingAccounts'
import { FbReportFetchErrorCode } from '../shared/fbReportCsv'

/** Primary entry: the business-scoped Ads Reporting view. */
const REPORTING_BUSINESS_VIEW_URL = 'https://adsmanager.facebook.com/adsmanager/reporting/business_view'
/** Fallback entries, tried in order when the primary one fails to land. */
const ADS_REPORTING_URL = 'https://adsmanager.facebook.com/adsreporting/'
const DOWNLOAD_DIR_FILES_LIMIT = 20
const NAV_TIMEOUT_MS = 45_000
const PAGE_READY_TIMEOUT_MS = 25_000
const CLICK_TIMEOUT_MS = 12_000
const REPORT_OPEN_TIMEOUT_MS = 30_000
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

// 所有报告 breadcrumb intentionally unused: it lands on an account-scoped
// manage list that does not contain the business's saved reports.
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
    'let usableCands = cands.filter((c) => usable(c, false)).sort(rank);' +
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
    '  usableCands = labelled.filter((c) => usable(c, false)).sort(rank);' +
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
  'let usableCands = cands.filter((c) => usable(c, false)).sort(rank);' +
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
  '  usableCands = labelled.filter((c) => usable(c, false)).sort(rank);' +
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

/** The surface's own report search (按名称、编号或指标等筛选条件搜索). */
const LOCATE_REPORT_SEARCH: Locator = {
  script: pageCall(
    'const input = Array.from(document.querySelectorAll("input")).find((i) =>' +
    '  /按名称、编号或指标|filter by name|name, number/i.test(i.placeholder || "") && i.offsetParent !== null);' +
    'if (!input) return null;' +
    'const r = input.getBoundingClientRect();' +
    'if (r.width < 4 || r.height < 4) return null;' +
    'return { x: r.x, y: r.y, w: r.width, h: r.height, text: cut(input.placeholder || "search", 30) };'
  ),
  diag: pageCall(
    'const inputs = Array.from(document.querySelectorAll("input")).filter((i) => i.offsetParent !== null);' +
    'return { count: inputs.length, placeholders: inputs.slice(0, 8).map((i) => cut(i.placeholder || "", 30)) };'
  )
}

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
  const script =
    '(() => {' +
    'const dlg = document.querySelector("[role=dialog]");' +
    'if (!dlg) return false;' +
    'const flat = (s) => (s || "").replace(/[\\u200b-\\u200f\\u202a-\\u202e\\ufeff]/g, "").replace(/\\s+/g, "");' +
    'const want = flat(' + JSON.stringify(reportName) + ');' +
    'if (!want) return false;' +
    'for (const i of dlg.querySelectorAll("input, [contenteditable]")) {' +
    '  const f = flat(String(i.value ?? i.textContent ?? ""));' +
    '  if (f && (f === want || f.startsWith(want) || want.startsWith(f))) return true;' +
    '}' +
    'return false;' +
    '})()'
  try {
    return (await panel.webContents.executeJavaScript(script, true)) === true
  } catch {
    return false
  }
}

/** The report switcher: the 「打开下拉菜单」 button immediately right of 保存
 *  (same row, gap ≤ 24px) — never 保存 itself, and never the second
 *  「打开下拉菜单」 that belongs to 导出 (it is not adjacent to 保存). */
const LOCATE_SAVE_CARET: Locator = {
  script: pageCall(
    'const p = caretCands().pairs.find((x) => x.c.vis && !x.c.save && x.c.pr.ok);' +
    'if (!p) return null;' +
    'const r = rectOf(p.c.target);' +
    'const at = p.c.pr.at || [r.left + r.width / 2, r.top + r.height / 2];' +
    'return { x: at[0] - 0.5, y: at[1] - 0.5, w: 1, h: 1, text: cut(p.c.name, 30) + " gap=" + Math.round(p.gap) + " at=" + Math.round(at[0]) + "," + Math.round(at[1]) };'
  ),
  diag: pageCall(
    'const d = (c) => ({ el: describe(c.el), target: describe(c.target), name: cut(c.name, 20),' +
      ' rect: [Math.round(c.r.left), Math.round(c.r.top), Math.round(c.r.width), Math.round(c.r.height)],' +
      ' visible: c.vis, occludedBy: c.pr.by, save: c.save });' +
      'const x = caretCands();' +
      'const uniq = (list) => list.filter((c, i) => list.findIndex((o) => o.target === c.target) === i);' +
      'return { view: [innerWidth, innerHeight], saves: uniq(x.saves).slice(0, 4).map(d), carets: uniq(x.carets).slice(0, 4).map(d),' +
      ' pairs: x.pairs.slice(0, 4).map((p) => ({ gap: Math.round(p.gap), caret: describe(p.c.target), ok: p.c.pr.ok, occludedBy: p.c.pr.by })) };'
  )
}

const LIST_READY_SCRIPT = `(() => {
  const text = (document.body.innerText || '').slice(0, 2500)
  const bad = /无法显示内容|链接可能已过期|isn't available|link may have expired/i.test(text)
  const create = /创建报告|Create report/.test(text)
  const visited = /上次访问|Last accessed|编辑时间|Edited/.test(text)
  const header = /所有报告|All reports|报告名称|Report name/.test(text)
  return { ready: !bad && (create || visited || header), url: location.href, snippet: text.replace(/\\s+/g, ' ').slice(0, 300) }
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

/** True once every dialog is invisible — after Escape the closed export
 *  dialog keeps a shadow node whose own 导出 button (a small 28x20 node)
 *  misleads the toolbar locator in step 4. */

/** True once every dialog is invisible — after Escape the closed export
 *  dialog keeps a shadow node whose own 导出 button (a small 28x20 node)
 *  misleads the toolbar locator in step 4. */
const NO_VISIBLE_DIALOG_SCRIPT = pageCall(
  'return !Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog]"))' +
    '.some((d) => { const r = d.getBoundingClientRect(); return r.width >= 50 && r.height >= 50; });'
)

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
    if (message === 'download-timeout') return { ok: false, error: 'download-timeout' }
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
function armDownload(session: Electron.Session, dir: string): DownloadWaiter {
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
      if (started) return
      started = true
      const original = item.getFilename()
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
        // FB surfaces occasionally drop the first click — re-assert hover
        // before pressing so the widget is fully primed.
        if (!panel.webContents.isDestroyed()) panel.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        await sleep(120)
        if (panel.webContents.isDestroyed()) return false
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

/** Types into the focused element (insertText — native CJK safe). */
async function realType(text: string): Promise<void> {
  const panel = getActiveBrowserPanel()
  if (!panel || panel.webContents.isDestroyed()) return
  panel.webContents.insertText(text)
  await sleep(300)
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

export function autoFetchFbReportCsv(reportName: string, reportId?: string): Promise<FbReportFetchResult> {
  return withBrowserActionLock<FbReportFetchResult>(async () => {
    const dir = downloadsDir()
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

    // 1) Open Ads Reporting under the registry's business scope.
    const accounts = listFbReadingAccounts()
    const businessId = accounts
      .map((account) => account.businessId)
      .find((id): id is string => typeof id === 'string' && /^\d{1,32}$/.test(id))
    const act = accounts
      .map((account) => account.act)
      .find((id) => typeof id === 'string' && /^\d{6,20}$/.test(id))
    const deepLink = reportId !== undefined && /^\d{1,32}$/.test(reportId)
    // Mirror the working URL shape: selected_report_id is ignored by FB
    // today, so the report is still opened through the UI below.
    const params: string[] = []
    if (act) params.push('act=' + act, 'ads_manager_write_regions=true')
    if (businessId) params.push('business_id=' + businessId)
    if (deepLink) params.push('event_source=CLICK_REPORTS_FROM_SIDE_NAV', 'selected_report_id=' + reportId)
    const query = params.length > 0 ? '?' + params.join('&') : ''
    log('start', { report: bounded(reportName), act: Boolean(act), business: Boolean(businessId), deepLink })
    await navigate(REPORTING_BUSINESS_VIEW_URL + query)
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
    // Attached-visible panels swallow injected clicks intermittently (the
    // proven-reliable layout is the parked, stretched one the reading
    // pipeline uses). Hide the panel for the interaction; the viewport wrap
    // below then parks+stretches it, and the user can reopen it afterwards.
    const ownerWindow = BrowserWindow.fromWebContents(activePanel.webContents)
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      try {
        hideBrowserPanel(ownerWindow)
      } catch {
        // hide is best-effort; the wrap below still guarantees a layout
      }
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

      // 2) Land on the reporting surface (fall back through known entries).
      const listReady = async (): Promise<{ ready: boolean; snippet: string }> => {
        const polled = await poll(LIST_READY_SCRIPT, PAGE_READY_TIMEOUT_MS)
        if (polled && typeof polled === 'object') {
          const info = polled as { ready?: boolean; snippet?: string; url?: string }
          return { ready: info.ready === true, snippet: (info.url ?? '') + ' | ' + (info.snippet ?? '') }
        }
        return { ready: false, snippet: await pageSnippet() }
      }
      let landing = await listReady()
      if (!landing.ready) {
        // Alternate surfaces, each carrying the same scope params — the
        // classic adsreporting home only lists saved reports when scoped.
        const fallbacks = [
          ADS_REPORTING_URL + query,
          REPORTING_BUSINESS_VIEW_URL,
          ADS_REPORTING_URL,
          'https://business.facebook.com/reports/'
        ]
        for (const fallback of fallbacks) {
          log('fallback', { url: fallback.split('?')[0] })
          await navigate(fallback)
          const fallbackUrl = await panelUrl()
          if (LOGIN_URL.test(fallbackUrl)) {
            log('login-required')
            return { ok: false, error: 'login-required', detail: bounded(fallbackUrl) }
          }
          landing = await listReady()
          if (landing.ready) break
        }
      }
      if (!landing.ready) {
        log('navigation-failed')
        return { ok: false, error: 'navigation-failed', detail: landing.snippet }
      }
      log('landed')

      // 3) FAST PATH: the deep-link view usually IS the target report — its
      //    export dialog's 导出内容名称 names it. Probe once: click 导出,
      //    verify the name inside the dialog, close it, and skip the whole
      //    report-opening dance. On mismatch fall through to opening below.
      let viewIsTarget = false
      // The toolbar click is intermittently swallowed on this surface (works
      // via OS-level events, flaky via injected input) — retry a few times,
      // stopping as soon as a dialog or menu appears.
      // Let the freshly landed page settle before the first toolbar click.
      await sleep(2_000)
      for (let probeAttempt = 1; probeAttempt <= 4 && !viewIsTarget; probeAttempt += 1) {
        const activated =
          (probeAttempt % 2 === 1
            ? await activateByKeyboard(4_000, 'export')
            : await realClick(LOCATE_EXPORT, 4_000, 'export(probe)'))
        if (activated) {
          // 导出 opens a dialog on the report view but a MENU on other
          // surfaces — either means the export path is live (step 4 handles
          // both shapes).
          const overlayLive =
            (await poll(OVERLAY_PRESENT_SCRIPT, DIALOG_TIMEOUT_MS, 700)) === true ||
            (await poll(DIALOG_PRESENT_SCRIPT, 2_000, 700)) === true
          if (overlayLive) {
            // Format dialog already open? Finish the export IN it — closing
            // and reopening only drifts the page state (the toolbar moves
            // and stray 导出 nodes win the locator).
            if ((await poll(DIALOG_PRESENT_SCRIPT, 1_500, 500)) === true) {
              const dlgPanel = getActiveBrowserPanel()
              if (!dlgPanel || dlgPanel.webContents.isDestroyed()) {
                return { ok: false, error: 'panel-not-open' }
              }
              const download = armDownload(dlgPanel.webContents.session, dir)
              try {
                log('fast-path probe', { attempt: probeAttempt, namesTarget: await exportDialogNames(reportName), finish: 'in-dialog' })
                return await finishExport(download)
              } finally {
                download.cancel()
              }
            }
            // The name field is the export FILENAME, not a data oracle — the
            // deep-link view always carries the business scope and the target
            // report's structure. Log the name match, never gate on it: the
            // date window is whatever the view holds and is shown as-is.
            viewIsTarget = true
            log('fast-path probe', { attempt: probeAttempt, namesTarget: await exportDialogNames(reportName) })
            // Close the probe dialog either way; the real export below reopens it.
            await pressEscape()
            // The closed dialog's DOM lingers briefly and its own 导出 button
            // (a small 28x20 node) shadows the toolbar one in the locator —
            // wait until no VISIBLE dialog remains before clicking again.
            for (let gone = 0; gone < 10; gone += 1) {
              const visibleDialog = await poll(NO_VISIBLE_DIALOG_SCRIPT, 400, 300)
              if (visibleDialog === true) break
              await sleep(300)
            }
            await sleep(600)
          } else {
            log('probe click swallowed', { attempt: probeAttempt })
            await sleep(3_000)
          }
        }
      }

      // 3b) Open the target report when the fast path didn't match. The
      //    surface's own search box and the 保存 ▾ switcher menu both list
      //    saved reports; the 所有报告 breadcrumb leads to an account-scoped
      //    list and is deliberately NOT used.
      let opened = false
      for (let attempt = 0; attempt < 3 && !opened && !viewIsTarget; attempt += 1) {
        // FB blocks navigation with the unsaved-changes guard; discard and
        // let the pending navigation continue.
        if (await realClick(LOCATE_DONT_SAVE, 2_000, 'discard-guard')) {
          await sleep(1_200)
        }
        opened = await realClick(locateReportByName(reportName), 8_000, 'report-name')
        if (opened) break
        // Human path: the surface's own search box — type the name, Enter.
        if (await realClick(LOCATE_REPORT_SEARCH, 3_000, 'report-search')) {
          await sleep(300)
          await realType(reportName)
          await sleep(200)
          await pressReturn()
          await sleep(2_000)
          // The search may jump straight to the report or show result rows.
          if (await realClick(locateReportByName(reportName), 8_000, 'report-name(search)')) {
            opened = true
            break
          }
        }
        // The switcher menu (打开下拉菜单 caret next to 保存) lists every
        // saved report ON THIS business-scoped surface. NOTE: the 所有报告
        // breadcrumb navigates to an account-scoped manage list with no
        // saved reports — it is deliberately NOT used.
        if (await realClick(LOCATE_SAVE_CARET, 4_000, 'switcher-caret')) {
          await sleep(1_200)
          opened = await realClick(locateReportByName(reportName), 6_000, 'report-name(menu)')
          // Close whatever the caret opened (Escape is not an edit).
          if (!opened) await pressEscape()
        }
      }
      if (!opened && !viewIsTarget) {
        log('report-not-found')
        return { ok: false, error: 'report-not-found', detail: await pageSnippet() }
      }

      // 4) Export: toolbar 导出 → (menu 导出表格数据) → dialog → CSV → confirm.
      //    The one-shot download waiter is armed before the first export
      //    click and always disarmed on the way out.
      await sleep(2_000)
      const panel = getActiveBrowserPanel()
      if (!panel || panel.webContents.isDestroyed()) return { ok: false, error: 'panel-not-open' }
      const download = armDownload(panel.webContents.session, dir)
      try {
        const exportClicked = await realClick(LOCATE_EXPORT, REPORT_OPEN_TIMEOUT_MS, 'export')
        if (!exportClicked) {
          log('export-button-not-found')
          return { ok: false, error: 'export-button-not-found', detail: await pageSnippet() }
        }
        const overlay = await poll(OVERLAY_PRESENT_SCRIPT, DIALOG_TIMEOUT_MS, 700)
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
        return await finishExport(download)
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
