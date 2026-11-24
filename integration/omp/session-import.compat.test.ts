import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { canonicalExistingPath } from '../../src/main/canonicalPath'
import { OmpSession, type OmpProcessLike } from '../../src/main/omp/OmpSession'
import type { SessionEvent } from '../../src/shared/types'
import { binaryAvailable, createIsolatedOmpEnvironment, requireBinary } from './isolated-runtime'

vi.mock('../../src/main/omp', () => ({ detectCli: () => ({ command: 'omp' }) }))

import { listSessionHistory } from '../../src/main/sessionHistory'
import { importSessionHistory } from '../../src/main/sessionImport'

describe('native runtime compatibility for imported history', () => {
  it('continues each imported copy with its original text while keeping source bytes and mtime', async () => {
    const bin = process.env.OMP_BIN || 'omp'
    if (!binaryAvailable(bin)) {
      requireBinary(bin)
      return
    }
    const processPlatform = process.platform
    const iso = createIsolatedOmpEnvironment()
    const root = canonicalExistingPath(iso.root)
    const workspaceDirectory = path.join(root, 'workspace')
    mkdirSync(workspaceDirectory)
    // Main receives canonical paths from ProjectRegistry. The JS realpathSync
    // can retain a short Windows CI temp-path spelling that the registry rejects.
    const workspace = canonicalExistingPath(workspaceDirectory)
    for (const key of ['OMP_PROFILE', 'PI_PROFILE', 'OMP_CODING_AGENT_DIR', 'OMP_CONFIG_PATH']) delete iso.env[key]
    Object.assign(iso.env, {
      XDG_CONFIG_HOME: iso.homeDir, XDG_DATA_HOME: iso.homeDir, XDG_CACHE_HOME: iso.homeDir,
      USERPROFILE: iso.homeDir, APPDATA: iso.homeDir, LOCALAPPDATA: iso.homeDir, NO_PROXY: '127.0.0.1'
    })
    const requests: string[] = []
    const provider = createServer(async (req, res) => {
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      requests.push(Buffer.concat(chunks).toString())
      const reply = { id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'fake',
        choices: [{ index: 0, delta: { content: 'Synthetic continuation reply.' }, finish_reason: 'stop' }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        provider.once('error', reject)
        provider.listen(0, '127.0.0.1', resolve)
      })
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('Synthetic provider unavailable')
      writeFileSync(path.join(iso.agentDir, 'models.yml'), YAML.stringify({ providers: {
        localtest: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
          models: [{ id: 'fake', name: 'Synthetic model', reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 1024 }]
        }
      } }))

      for (const source of ['codex', 'claude'] as const) {
        const sourceDirectory = path.join(root, source)
        const id = '123e4567-e89b-42d3-a456-426614174000'
        const timestamp = '2026-11-20T01:00:00.000Z'
        const question = `Synthetic ${source} original question.`
        const answer = `Synthetic ${source} original answer.`
        const history = source === 'codex' ? [
          { type: 'session_meta', timestamp, payload: { id, cwd: workspace, timestamp, title: 'Codex import fixture' } },
          { type: 'event_msg', timestamp, payload: { type: 'user_message', message: question } },
          { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: answer } }
        ] : [
          { type: 'user', sessionId: id, uuid: 'u', parentUuid: null, cwd: workspace, timestamp, message: { role: 'user', content: question } },
          { type: 'assistant', sessionId: id, uuid: 'a', parentUuid: 'u', cwd: workspace, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }
        ]
        const sourceFile = source === 'codex'
          ? path.join(sourceDirectory, `sessions/2026/11/20/rollout-2026-11-20T01-00-00-${id}.jsonl`)
          : path.join(sourceDirectory, 'projects/synthetic', id + '.jsonl')
        mkdirSync(path.dirname(sourceFile), { recursive: true })
        const original = history.map(record => JSON.stringify(record)).join('\n') + '\n'
        writeFileSync(sourceFile, original)
        const mtime = statSync(sourceFile).mtimeMs
        const options = { source, sourceDirectory, agentDir: iso.agentDir, defaultWorkspace: workspace, projects: new Set([workspace]) }
        const pathAliases = {
          fixtureRoot: realpathSync(iso.root) !== root,
          agentDir: canonicalExistingPath(iso.agentDir) !== iso.agentDir
        }
        expect(await importSessionHistory(options), `${source} fixture on ${processPlatform} (path aliases ${JSON.stringify(pathAliases)})`).toMatchObject({
          ok: true, imported: 1, failed: 0, defaultWorkspace: 0
        })
        const file = (await listSessionHistory(workspace, iso.agentDir)).find(row => row.importedFrom === source)?.filePath
        expect(file).toBeTruthy()

        const process = iso.spawnRpc(bin, [
          '--session', file as string, '--model', 'localtest/fake', '--no-tools',
          '--no-extensions', '--no-skills', '--no-rules', '--no-title'
        ])
        const closed = new Promise<void>(resolve => process.once('close', () => resolve()))
        const events: SessionEvent[] = []
        let stderr = ''
        process.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000) })
        const session = new OmpSession(
          { id: source, cwd: workspace, title: source, createdAt: Date.now(), status: 'idle' },
          process as unknown as OmpProcessLike,
          { label: bin, onEvent: event => events.push(event) }
        )
        try {
          await vi.waitFor(() => expect(session.handshakeOutcome?.profile, stderr).toBe('current'), { timeout: 15_000 })
          const before = JSON.stringify((await session.query({ type: 'get_messages' }))?.data)
          expect(before).toContain(question)
          expect(before).toContain(answer)
          const continuation = `Continue the ${source} fixture conversation.`
          const nextEvent = events.length
          expect(session.sendPrompt(continuation)).toBe(true)
          await vi.waitFor(() => {
            expect(events.slice(nextEvent), stderr).toContainEqual(expect.objectContaining({ type: 'status', status: 'idle' }))
          }, { timeout: 12_000 })
          expect(requests.at(-1)).toContain(question)
          expect(requests.at(-1)).toContain(answer)
          expect(requests.at(-1)).toContain(continuation)
          expect(JSON.stringify((await session.query({ type: 'get_messages' }))?.data)).toContain('Synthetic continuation reply.')
        } finally {
          session.kill()
          await closed
        }
        expect(await importSessionHistory(options)).toMatchObject({ ok: true, imported: 0, duplicates: 1 })
        expect(readFileSync(sourceFile, 'utf8')).toBe(original)
        expect(statSync(sourceFile).mtimeMs).toBe(mtime)
        expect(readFileSync(file as string, 'utf8')).toContain('Synthetic continuation reply.')
      }
      expect(requests).toHaveLength(2)
    } finally {
      await new Promise<void>(resolve => provider.close(() => resolve()))
      iso.cleanup()
    }
  })
})
