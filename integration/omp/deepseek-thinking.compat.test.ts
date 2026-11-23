import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { OmpSession, type OmpProcessLike } from '../../src/main/omp/OmpSession'
import { sessionModelThinking } from '../../src/main/omp/OmpProtocol'
import type { SessionEvent, SessionState } from '../../src/shared/types'
import { binaryAvailable, createIsolatedOmpEnvironment, requireBinary } from './isolated-runtime'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../../src/main/omp', () => ({ detectCli: () => ({ available: false }) }))
import { repairDiscoveredModelThinking } from '../../src/main/customProviders'

const MODEL_ID = 'deepseek-flash'
const MODEL_NAME = 'DeepSeek-V4.1-Flash'
const SELECTOR = `deepseek/${MODEL_ID}`
const EFFORTS = ['low', 'high', 'max'] as const

describe('DeepSeek Flash runtime thinking', () => {
  it('keeps the discovered model and sends each selected effort on the wire', async () => {
    const bin = process.env.OMP_BIN || 'omp'
    if (!binaryAvailable(bin)) {
      requireBinary(bin)
      return
    }
    const iso = createIsolatedOmpEnvironment()
    const requests: Array<Record<string, unknown>> = []
    const provider = createServer(async (request, response) => {
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          object: 'list',
          data: [{ id: MODEL_ID, name: MODEL_NAME, object: 'model', owned_by: 'deepseek' }]
        }))
        return
      }
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = {
        id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: MODEL_ID,
        choices: [{ index: 0, delta: { content: 'Synthetic result.' }, finish_reason: 'stop' }]
      }
      response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`)
    })
    const lifecycle: { closeSession?: () => Promise<void> } = {}
    try {
      await new Promise<void>((resolve, reject) => {
        provider.once('error', reject)
        provider.listen(0, '127.0.0.1', resolve)
      })
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('Missing loopback provider address')
      const modelsFile = path.join(iso.agentDir, 'models.yml')
      const fixture = { providers: { deepseek: { apiKey: 'synthetic-deepseek-key' } } }
      delete iso.env.OMP_PROFILE
      delete iso.env.PI_PROFILE
      Object.assign(iso.env, {
        USERPROFILE: iso.homeDir,
        APPDATA: iso.homeDir,
        LOCALAPPDATA: iso.homeDir,
        XDG_CONFIG_HOME: iso.homeDir,
        XDG_DATA_HOME: iso.homeDir,
        XDG_CACHE_HOME: iso.homeDir,
        OMP_CODING_AGENT_DIR: iso.agentDir
      })

      const startSession = async () => {
        // Keep the migration's input a direct provider entry. Redirect that
        // entry before every spawn so discovery and chat stay on loopback.
        const config = YAML.parse(readFileSync(modelsFile, 'utf8'))
        config.providers.deepseek.baseUrl = `http://127.0.0.1:${address.port}`
        writeFileSync(modelsFile, YAML.stringify(config), { mode: 0o600 })
        const proc = iso.spawnRpc(bin, [
          '--model', SELECTOR, '--no-session', '--no-tools',
          '--no-extensions', '--no-skills', '--no-rules', '--no-title'
        ])
        const exited = new Promise<void>(resolve => proc.once('close', () => resolve()))
        const events: SessionEvent[] = []
        let stderr = ''
        proc.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000) })
        const session = new OmpSession(
          { id: 'deepseek-thinking', cwd: iso.agentDir, title: MODEL_NAME, createdAt: Date.now(), status: 'idle' },
          proc as unknown as OmpProcessLike,
          { label: bin, onEvent: event => events.push(event) }
        )
        lifecycle.closeSession = async () => {
          session.kill()
          await exited
        }
        await vi.waitFor(() => expect(session.handshakeOutcome?.profile, stderr).toBe('current'), { timeout: 15_000 })
        return { session, events, stderr: () => stderr }
      }

      writeFileSync(modelsFile, YAML.stringify(fixture), { mode: 0o600 })
      const original = await startSession()
      const discovered = await original.session.query({ type: 'get_state' })
      expect(discovered, original.stderr()).toMatchObject({
        success: true, data: { model: { provider: 'deepseek', id: MODEL_ID } }
      })
      const capability = sessionModelThinking((discovered?.data as SessionState).model)
      const hasNativeEfforts = capability?.reasoning === true && capability.thinking.length > 0
      if (!hasNativeEfforts) {
        expect(capability).toEqual({ reasoning: false, thinking: [] })
        await lifecycle.closeSession?.()
        delete lifecycle.closeSession
        writeFileSync(modelsFile, YAML.stringify(fixture), { mode: 0o600 })
        expect(await repairDiscoveredModelThinking([
          { provider: 'deepseek', id: MODEL_ID, selector: SELECTOR, name: MODEL_NAME, reasoning: false, thinking: [] }
        ], new Map([[SELECTOR, { mode: 'effort', efforts: [...EFFORTS] }]]), modelsFile)).toBe(true)
      }

      const { session, events, stderr } = hasNativeEfforts ? original : await startSession()
      const initial = await session.query({ type: 'get_state' })
      expect(initial, stderr()).toMatchObject({
        success: true, data: { model: { provider: 'deepseek', id: MODEL_ID } }
      })
      expect(sessionModelThinking((initial?.data as SessionState).model)).toEqual({ reasoning: true, thinking: EFFORTS })

      for (const level of ['off', ...EFFORTS]) {
        expect(await session.query({ type: 'set_thinking_level', level }), stderr()).toMatchObject({ success: true })
        expect(await session.query({ type: 'get_state' }), stderr()).toMatchObject({ data: { thinkingLevel: level } })
        const firstEvent = events.length
        const requestIndex = requests.length
        expect(session.sendPrompt(`Synthetic ${level} probe.`)).toBe(true)
        await vi.waitFor(() => {
          expect(events.slice(firstEvent), stderr()).toContainEqual(expect.objectContaining({ type: 'status', status: 'idle' }))
        }, { timeout: 12_000 })
        expect(requests).toHaveLength(requestIndex + 1)
        const body = requests[requestIndex]
        expect(body.model).toBe(MODEL_ID)
        if (level === 'off') {
          expect(body.thinking).toEqual({ type: 'disabled' })
          expect(body).not.toHaveProperty('reasoning_effort')
        } else {
          expect(body.thinking).toEqual({ type: 'enabled' })
          expect(body.reasoning_effort).toBe(level)
        }
      }
    } finally {
      await lifecycle.closeSession?.()
      provider.closeAllConnections()
      await new Promise<void>(resolve => provider.close(() => resolve()))
      iso.cleanup()
    }
  }, 60_000)
})
