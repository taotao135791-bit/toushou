import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { htmlBoardTemplate, renderHtmlBoard, type HtmlBoardDocument } from '../../../shared/htmlBoard'

const require_ = createRequire(import.meta.url)
const fixture = (): HtmlBoardDocument => ({
  schemaVersion: 1, id: 'test', revision: 1,
  source: { boardId: 'board', widgetId: 'widget', snapshotHash: 'a'.repeat(64) },
  snapshot: { kind: 'reading-snapshot', version: 1, rangeLabel: 'test', window: { start: '2026-01-01', end: '2026-01-02' }, capturedAt: 1000,
    accounts: [{ platform: 'tiktok', accountId: 'SECRET_ID', name: 'SECRET_NAME', status: 'ok', statusDetail: null, window: { start: '2026-01-01', end: '2026-01-02' }, previousWindow: null, sourceAt: 900, timezone: null, currency: 'USD', spend: 10, previousSpend: null, impressions: 20, clicks: 3, conversions: 1 }] },
  includeChart: true, ...htmlBoardTemplate('minimal', 'en'), createdAt: 1, updatedAt: 1
})

describe('custom HTML board isolation in Electron', () => {
  it('rejects active content and keeps the trusted report visible, offline and isolated', { timeout: 75000 }, () => {
    const doc = fixture()
    for (const html of [
      '<script>parent.pwned=1</script><div data-reading-slot></div>',
      '<img src="http://127.0.0.1:1/leak"><div data-reading-slot></div>',
      '<a href="https://example.invalid">escape</a><div data-reading-slot></div>',
      '<div onclick="parent.pwned=1"></div><div data-reading-slot></div>',
      '<svg onload="parent.pwned=1"></svg><div data-reading-slot></div>'
    ]) expect(() => renderHtmlBoard({ ...doc, html })).toThrow()
    for (const css of ['@import "http://127.0.0.1:1/leak";', '* { background: url(http://127.0.0.1:1/leak); }', '* { position: fixed; }', '* { margin: -1px; }', 'body + main { display: none; }']) {
      expect(() => renderHtmlBoard({ ...doc, css })).toThrow()
    }
    // A deliberately hostile but allowed selector can affect custom text only.
    doc.html = '<section class="probe">hide me</section><div data-reading-slot></div><p>after</p>'
    doc.css = '* { display: none; color: red; }'
    const exported = renderHtmlBoard(doc, { language: 'en' })
    const dir = mkdtempSync(path.join(os.tmpdir(), 'html-board-security-'))
    try {
      writeFileSync(path.join(dir, 'export.html'), exported)
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'htmlBoardSecurity.harness.cjs'), dir], { encoding: 'utf8', timeout: 60000, env })
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, `${result.stdout}\n${result.stderr}`).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(data.monitorWorked).toBe(true)
      expect(data.direct).toMatchObject({ tableVisible: true, customHidden: true, anonymous: true, noSvg: true, noScripts: true })
      expect(data.frame).toMatchObject({ tableVisible: true, customHidden: true, anonymous: true, noSvg: true, noScripts: true, parentBlocked: true, noNode: true })
      expect(data.directFetchBlocked).toBe(true)
      expect(data.frameFetchBlocked).toBe(true)
      expect(data.networkRequests).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
