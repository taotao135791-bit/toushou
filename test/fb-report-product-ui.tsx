// Real React component, isolated Electron renderer, synthetic reports only.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FbReportReadingBody } from '../src/renderer/pages/boards/FbReportReadingBody'
import { useAppStore } from '../src/renderer/store'
import { createWidget, applyMasterScope } from '../src/shared/boards'
import { parseFbReportCsv } from '../src/shared/fbReportCsv'

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const records = new Map()
const calls: unknown[][] = []
let finishFetch: (() => void) | undefined
let fail = false
const fakeApi = {
  fbReportReadingGet: async (id: string) => records.get(id) ?? null,
  fbReportAutoFetch: async (...args: unknown[]) => {
    calls.push(args)
    await new Promise<void>((resolve) => { finishFetch = resolve })
    if (fail) return { ok: false, fetchError: 'download-timeout' }
    const [id, reportName] = args
    const csv = `账户名称,单日,货币,已花费金额 (USD),展示次数,报告开始日期,报告结束日期\n,,USD,10,100,2026-10-29,2026-10-29\n${reportName}-account,2026-10-29,USD,10,100,2026-10-29,2026-10-29\n`
    const outcome = parseFbReportCsv(csv)
    assert(outcome.verification.verified, 'fixture CSV must verify')
    records.set(id, { widgetId: id, importedAt: Date.now(), fileName: 'fixture.csv', contractVersion: 1, summary: outcome.summary, warnings: [] })
    return { ok: true, outcome }
  }
}
Object.assign(window, { electronAPI: fakeApi })
useAppStore.setState({ language: 'zh' })
let saved: Record<string, unknown>
let changeRange: (range: string) => void
function App() {
  const [config, setConfig] = useState<Record<string, unknown>>({ range: 'last7' })
  changeRange = (range) => setConfig((prev) => applyMasterScope({ ...createWidget('fb-report-reading', 'Demo', { x: 0, y: 0 }), config: prev }, { range: range as 'today' | 'last7' | 'last3' | 'yesterday', metrics: ['spend'] }).config)
  return <FbReportReadingBody widget={{ ...createWidget('fb-report-reading', 'Demo', { x: 0, y: 0 }), id: 'fixture-widget', config }} onConfigChange={(value) => { saved = value; setConfig(value) }} />
}
createRoot(document.getElementById('root')!).render(<App />)
const text = () => document.body.textContent ?? ''
const click = async (label: string) => {
  const el = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  assert(el && !el.disabled, `button unavailable: ${label}`)
  el!.click(); await tick()
}
const field = (label: string, value: string) => {
  const el = Array.from(document.querySelectorAll('label')).find((l) => l.textContent === label)?.querySelector('input')
  assert(el, `input missing: ${label}`)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el!.dispatchEvent(new Event('input', { bubbles: true }))
}
const choose = async (id: string) => {
  const el = document.querySelector('select')!
  el.value = id; el.dispatchEvent(new Event('change', { bubbles: true })); await tick()
}
const add = async (name: string, report: string, id: string) => {
  await click('添加产品')
  field('产品名称', name); field('Facebook 报表名称', report); field('报表链接或 ID（可选）', id)
  await tick(); await click('保存关联')
}
Object.assign(window, { runProductTest: async () => {
  await tick()
  assert(calls.length === 0, 'mount must not fetch')
  await add('Demo A', 'Saved A', '123')
  const a = saved.selectedProductId as string
  assert(calls.length === 0, 'binding must not fetch')
  await click('自动获取')
  window.dispatchEvent(new CustomEvent('fb-report-reading:board-refresh', { detail: { widgetId: 'fixture-widget' } }))
  await tick()
  assert(calls.length === 1, 'refresh-all must join in-flight manual export')
  assert(JSON.stringify(calls[0]) === JSON.stringify([a, 'Saved A', '123', 'last7']), 'fetch must carry selected report + date')
  finishFetch!(); await tick(); await tick()
  assert(text().includes('Saved A-account'), 'successful A reading missing')
  await click('证据')
  assert(text().includes('fixture.csv'), 'main provenance details must remain available')
  await add('Demo B', 'Saved B', '456')
  const b = saved.selectedProductId as string
  assert(a !== b, 'products must have isolated store keys')
  assert(!text().includes('Saved A-account'), 'A data leaked into B')
  assert(calls.length === 1, 'switch/add must not export')
  changeRange('today'); await tick()
  await click('自动获取'); finishFetch!(); await tick(); await tick()
  assert(calls[1][3] === 'today', 'date changes must reach the next fetch')
  assert(text().includes('Saved B-account'), 'successful B reading missing')
  await choose(a)
  assert(text().includes('Saved A-account') && !text().includes('Saved B-account'), 'cached A lookup mixed products')
  fail = true
  await click('自动获取'); finishFetch!(); await tick(); await tick()
  assert(text().includes('Saved A-account'), 'failed refresh lost old A data')
  await choose(b)
  assert(!text().includes('超时'), 'A error leaked into B')
  await click('编辑产品'); field('产品名称', 'Renamed B'); await tick(); await click('保存关联')
  assert(saved.selectedProductId === b && text().includes('Saved B-account'), 'rename should preserve cached data')
  await click('编辑产品'); field('报表链接或 ID（可选）', '789'); await tick(); await click('保存关联')
  assert(saved.selectedProductId !== b && !text().includes('Saved B-account'), 'rebind must discard previous source display')
  await click('编辑产品'); await click('删除关联')
  assert(saved.selectedProductId === '', 'delete must not silently select another product')
  assert(calls.length === 3, 'editing/renaming/deleting triggered an export')
  await choose(a); changeRange('last3'); await tick()
  const fetchButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '自动获取')
  assert(fetchButton?.disabled, 'unsupported range must disable fetching')
  window.dispatchEvent(new CustomEvent('fb-report-reading:board-refresh', { detail: { widgetId: 'fixture-widget' } }))
  await tick()
  assert(calls.length === 3, 'unsupported range must not export via refresh-all')
  changeRange('yesterday'); await tick()
  assert(fetchButton?.disabled, 'yesterday must not export an old range')
  window.dispatchEvent(new CustomEvent('fb-report-reading:board-refresh', { detail: { widgetId: 'fixture-widget' } }))
  await tick()
  assert(calls.length === 3, 'unsupported yesterday must not export via refresh-all')
  changeRange('last7'); await tick()
  assert(!fetchButton?.disabled && calls.length === 3, 'supported preset should enable explicit fetch without auto-exporting')
  return { passed: true, exports: calls.length, checks: ['explicit fetch', 'selected report and range', 'single flight', 'product isolation', 'failure retains data', 'rename preserves cache', 'rebind clears display', 'deletion clears selection'] }
} })
