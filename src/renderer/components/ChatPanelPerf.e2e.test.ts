import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('ChatPanel background metadata rendering', () => {
  it('ignores 200 background changes while current conversation updates remain live', { timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-panel-perf-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (options: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'ChatPanelPerf.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const cssPath = path.resolve(__dirname, '../index.css')
      const css = await require_('postcss')([require_('tailwindcss')(), require_('autoprefixer')()]).process(readFileSync(cssPath, 'utf8'), { from: cssPath })
      writeFileSync(path.join(dir, 'fixture.css'), css.css + '\n' + readFileSync(path.join(__dirname, 'AgentHome.css'), 'utf8'))
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'ChatPanelPerf.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      expect(result.error).toBeUndefined()
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, JSON.stringify({ status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code, stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0 })).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(result.status, JSON.stringify({ status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code })).toBe(0)
      console.info('CHAT_PANEL_PERF ' + JSON.stringify(data))
      expect(data.chatMenuAbove).toBe(true)
      expect(data.effortInteraction).toEqual({ insetMenu: true, themed: true, trackHasStars: true, hiddenAuto: true })
      expect(data.homeMenusBelow).toEqual([true, true, true, true, true])
      expect(data.deepSeekThinking).toEqual(['Off', 'Low', 'High', 'Max', 'Auto'])
      expect(data.mediumOnlyThinking).toEqual(['Off', 'Medium', 'Auto'])
      expect(data.plainThinking).toEqual(['Off', 'Auto'])
      expect(data.thinkingSelections).toEqual(['low', 'high', 'max', 'off', 'medium', 'auto'].map(level => ({ sessionId: 'current', level })))
      expect(data.background.updates).toBe(200)
      expect(data.background.visible).toBe('visible')
      expect(data.background.commits, JSON.stringify(data)).toBe(0)
      expect(data.background.header).toContain('Current conversation')
      expect(data.renamed.title).toBe(true)
      expect(data.renamed.commits).toBeGreaterThan(data.background.commits)
      expect(data.status).toBeGreaterThan(data.renamed.commits)
      expect(data.permission).toBe(true)
      expect(data.content).toEqual({ message: true, error: 'Message failed to send.' })
      expect(data.busyError).toBe('Stop unconfirmed. Try again.')
      expect(data.restoredThinking).toEqual({ timers: 0, message: true })
      expect(data.activeThinking).toBe(1)
      expect(data.interruptedThinking).toBe(0)
      const { shortReasoning, longReasoning, collapsedReasoning, processAutoOpened, processManuallyOpened, punctuation, afterPunctuation } = data.boardStream
      expect(shortReasoning.reasoningHeight).toBeGreaterThan(0)
      expect(longReasoning.reasoningHeight).toBe(shortReasoning.reasoningHeight)
      expect(longReasoning.scrollHeight).toBe(shortReasoning.scrollHeight)
      expect(Math.abs(longReasoning.bottom)).toBeLessThanOrEqual(1)
      for (const sample of [longReasoning, collapsedReasoning, afterPunctuation]) {
        expect(sample.composerTop).toBe(shortReasoning.composerTop)
        expect(sample.composerHeight).toBe(shortReasoning.composerHeight)
      }
      expect(processAutoOpened).toBe(false)
      expect(processManuallyOpened).toBe(true)
      expect(punctuation).toEqual({ inProcess: true, separate: false, boardAction: false })
      expect(data.projectionWork.noAgent).toEqual({ activity: 0, messages: 0, empty: true })
      expect(data.projectionWork.closedAgent).toEqual({ activity: 0, messages: 0, countVisible: true })
      expect(data.projectionWork.openAgent).toEqual({ activity: 1, messages: 0, workerVisible: true })
      expect(data.projectionWork.completedElapsed).toBe(true)
      expect(data.homeTray.opensBelow).toBe(true)
      expect(data.homeTray.draft).toContain('Unsent default folder brief')
      expect(data.defaultRecovery).toEqual({ message: true, path: true, button: 'Reselect folder…', destination: 'Default workspace' })
      expect(data.defaultRecovered).toEqual({ calls: ['default'], workspace: '/synthetic/default-save-folder', source: 'default', missing: false, promptGone: true, draft: 'Unsent default folder brief' })
      expect(data.pickerUndo).toBe('Review')
      expect(data.mentionUndo).toBe('Review @')
      expect(data.composerSwitch).toEqual({ drafts: { first: 'Review @', second: 'Second draft' }, text: 'Second draft' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
