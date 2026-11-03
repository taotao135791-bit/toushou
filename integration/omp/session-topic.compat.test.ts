import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { spawnCommand } from '../../src/main/command'
import { createSessionNamer } from '../../src/main/sessionNaming'
import { initSessionTopicBridge, resetSessionTopicBridgeForTest, sessionTopicBridgeEnv } from '../../src/main/sessionTopicBridge'
import type { SessionTitleMetadata } from '../../src/shared/types'

/** Actual installed runtime + synthetic loopback provider; no live credentials or model requests. */
describe('same-turn session topic runtime compatibility', () => {
  it.each(['readonly', 'ask'])('loads and executes only session metadata without approval in %s mode', async (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), 'toushou-topic-omp-'))
    const home = path.join(root, 'home')
    const agentDir = path.join(root, 'agent')
    mkdirSync(home); mkdirSync(agentDir)
    const sessions = [{ id: 'synthetic', cwd: root, title: path.basename(root), titleSource: undefined as 'auto' | 'manual' | undefined, titleRevision: 0, sessionFile: path.join(root, 'synthetic.jsonl') }]
    let titles: Record<string, string> = {}
    let metadata: Record<string, SessionTitleMetadata> = {}
    const naming = createSessionNamer({
      getSession: (id) => sessions.find((session) => session.id === id), listSessions: () => sessions,
      getTitles: () => titles, saveTitles: (value) => { titles = value }, getMetadata: () => metadata, saveMetadata: (value) => { metadata = value },
      setRuntimeName: async () => true,
      markTitle: (id, title) => { const session = sessions.find((item) => item.id === id); if (!session) return null; session.title = title; return session.sessionFile },
      markMetadata: (id, value) => { const session = sessions.find((item) => item.id === id); if (session) { session.titleSource = value.source; session.titleRevision = value.revision } }
    })
    const revision = naming.advance('synthetic')
    await naming('synthetic', 'TikTok投放分析', { source: 'auto' })
    await initSessionTopicBridge({ getSession: id => sessions.find(session => session.id === id), getRevision: naming.revision, nameSession: naming })
    const requests: Array<Record<string, unknown>> = []
    const provider = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const request = JSON.parse(body) as Record<string, unknown>
        requests.push(request)
        const hasResult = Array.isArray(request.messages) && request.messages.some((message: { role?: string }) => message.role === 'tool')
        const choice = hasResult
          ? { index: 0, delta: { content: 'Synthetic topic complete.' }, finish_reason: 'stop' }
          : { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-topic-call', type: 'function', function: { name: 'toushou_session_topic', arguments: JSON.stringify({ title: 'TikTok成本诊断7123456789012345678', revision }) } }] }, finish_reason: 'tool_calls' }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [choice] })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    try {
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('synthetic-provider-unavailable')
      writeFileSync(path.join(agentDir, 'models.yml'), YAML.stringify({ providers: { localtopic: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'synthetic-no-live-credential', models: [{ id: 'topic-fixture', name: 'Synthetic local topic fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 512 }] } } }))
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const args = ['--mode', 'json', '--print', '--no-session', '--no-skills', '--no-rules', '--no-pty', '--no-title', '--max-time=20', '--thinking=low', '--model', 'localtopic/topic-fixture', '-e', path.resolve('resources/session-topic/index.ts'), '--approval-mode', mode === 'ask' ? 'always-ask' : 'yolo']
        if (mode === 'readonly') args.push('--tools', 'read,grep,glob,lsp,web_search,todo')
        args.push('Analyze this synthetic account and keep the sidebar topic concise.')
        const child = spawnCommand(process.env.OMP_BIN || 'omp', args, {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: '1', FORCE_COLOR: '0', ...sessionTopicBridgeEnv('synthetic') },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = '', stderr = ''
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('synthetic-runtime-timeout')) }, 25000)
        child.stdout?.on('data', chunk => { stdout += String(chunk) })
        child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000) })
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
      })
      expect(result.code, result.stderr).toBe(0)
      expect(requests.length).toBe(2)
      const tools = requests[0].tools as Array<{ function: { name: string } }>
      expect(tools.some(tool => tool.function.name === 'toushou_session_topic')).toBe(true)
      if (mode === 'readonly') expect(tools.some(tool => ['bash', 'edit', 'write', 'python'].includes(tool.function.name))).toBe(false)
      expect(JSON.stringify(requests[0].messages)).toContain(`revision=${revision}`)
      expect(sessions[0]).toMatchObject({ title: 'TikTok成本诊断', titleSource: 'auto', titleRevision: revision })
      expect(titles[sessions[0].sessionFile]).toBe('TikTok成本诊断')
      expect(metadata[sessions[0].sessionFile]).toEqual({ source: 'auto', revision })
      expect(result.stdout).toContain('Synthetic topic complete.')
      expect(result.stdout).not.toContain('extension_ui_request')
      expect(JSON.stringify(titles)).not.toContain('7123456789')
    } finally {
      await resetSessionTopicBridgeForTest()
      await new Promise<void>(resolve => provider.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})
