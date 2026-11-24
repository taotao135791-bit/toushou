import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { deflateSync, crc32 } from 'node:zlib'
import { mapAgentMessages, type AgentMessage } from '../../src/main/messageMapping'
import { readSessionFileTranscript } from '../../src/main/sessionTranscript'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createIsolatedOmpEnvironment, binaryAvailable, requireBinary } from './isolated-runtime'
import { OmpSession, type OmpProcessLike } from '../../src/main/omp/OmpSession'
import { RuntimeSettings } from '../../src/main/omp/settings/RuntimeSettings'
import { makeExecRunner } from '../../src/main/omp/settings/OmpConfigCli'
import type { RuntimeModelInfo, SessionEvent } from '../../src/shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../../src/main/omp', () => ({ detectCli: () => ({ available: false }) }))
import { saveCustomProvider } from '../../src/main/customProviders'

// Deterministic RGB noise stays above OMP's 1024-base64-character externalization
// threshold even if its image preprocessor re-encodes the PNG as WebP.
const side = 256
function syntheticPng(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4)
  header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc(side * (1 + 3 * side))
  let seed = 77
  for (let i = 0; i < pixels.length; i++) {
    if (i % (1 + 3 * side) === 0) continue // PNG scanline filter
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    pixels[i] = seed >>> 24
  }
  function chunk(type: string, data: Buffer) {
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

describe('custom model image input', () => {
  it('automatically restores a catalog model’s actual limits and transmits its PNG through pinned OMP', async () => {
    const bin = process.env.OMP_BIN || 'omp'
    if (!binaryAvailable(bin)) { requireBinary(bin); return }
    const iso = createIsolatedOmpEnvironment()
    delete iso.env.OMP_PROFILE
    delete iso.env.PI_PROFILE
    Object.assign(iso.env, { USERPROFILE: iso.homeDir, APPDATA: iso.homeDir, LOCALAPPDATA: iso.homeDir,
      XDG_CONFIG_HOME: iso.homeDir, XDG_DATA_HOME: iso.homeDir, XDG_CACHE_HOME: iso.homeDir, OMP_CODING_AGENT_DIR: iso.agentDir })
    const data = syntheticPng().toString('base64')
    const requests: { messages: Array<{ role: string; content: unknown }> }[] = []
    const server = createServer(async (request, response) => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'image-probe',
        choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
    })
    let cleanup: (() => Promise<void>) | undefined
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing loopback port')
      const deps = { modelsFile: path.join(iso.agentDir, 'models.yml'), runner: null, modelCatalog: [] }
      const model = { id: 'image-probe', name: 'Image probe' }
      const spec = { id: 'test-vision', baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions' as const,
        apiKey: 'synthetic-key', authNone: false, discovery: false, models: [model] }
      expect((await saveCustomProvider({ ...spec, models: [{ ...model, input: ['text'], contextWindow: 200000, maxTokens: 4096 }] }, deps)).ok).toBe(true)
      const native: RuntimeModelInfo = { ...model, provider: spec.id, api: spec.api, baseUrl: spec.baseUrl,
        selector: spec.id + '/' + model.id, input: ['text', 'image'], reasoning: false, thinking: [], contextWindow: 640000, maxTokens: 12000 }
      const settings = new RuntimeSettings({ cli: { command: 'omp', path: bin, available: true }, modelsFile: deps.modelsFile,
        runner: makeExecRunner(bin, { env: iso.env, timeoutMs: 15000 }), thinkingCatalog: () => new Map(),
        capabilityCatalog: () => new Map([[native.selector, native]]) })
      expect((await settings.listModels()).find(item => item.selector === native.selector)).toMatchObject({
        input: native.input, contextWindow: native.contextWindow, maxTokens: native.maxTokens
      })
      const runtimeArgs = ['--model', 'test-vision/image-probe', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-title']
      const events: SessionEvent[] = []
      let stderr = ''
      function openSession(file?: string) {
        const proc = iso.spawnRpc(bin, file ? ['--session', file, ...runtimeArgs] : runtimeArgs)
        const exited = new Promise<void>(resolve => proc.once('close', () => resolve()))
        proc.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2400) })
        const session = new OmpSession({ id: 'vision', cwd: iso.agentDir, title: 'Vision', createdAt: 1, status: 'idle' },
          proc as unknown as OmpProcessLike, { label: bin, onEvent: event => events.push(event) })
        cleanup = async () => { session.kill(); await exited }
        return session
      }
      const imagesInRuntime = async (runtime: OmpSession) => {
        const result = await runtime.query({ type: 'get_messages' })
        const messages = (result?.data as { messages: AgentMessage[] }).messages
        return mapAgentMessages(messages).find(row => row.role === 'user')?.images
      }
      const session = openSession()
      await vi.waitFor(() => expect(session.handshakeOutcome?.profile, stderr).toBe('current'), { timeout: 15_000 })
      expect(await session.query({ type: 'get_state' })).toMatchObject({ data: { model: {
        provider: spec.id, id: model.id, input: native.input, contextWindow: native.contextWindow, maxTokens: native.maxTokens
      } } })
      expect(session.sendPrompt('Describe the supplied pixel.', [{ type: 'image', mimeType: 'image/png', data }])).toBe(true)
      await vi.waitFor(() => expect(requests.length, stderr).toBe(1), { timeout: 10_000 })
      const user = requests[0].messages.find(message => message.role === 'user')
      // OMP's image preprocessor can convert the source PNG to JPEG or WebP before
      // it reaches the provider. Validate the actual payload and container.
      expect(Array.isArray(user?.content)).toBe(true)
      const image = (user?.content as Array<{ type: string; image_url?: { url: string } }>)
        .find(part => part.type === 'image_url')
      const source = image?.image_url?.url.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/)
      expect(source, image?.image_url?.url.slice(0, 60)).toBeTruthy()
      const bytes = Buffer.from(source![2], 'base64')
      if (source![1] === 'png') expect(bytes.subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
      else if (source![1] === 'jpeg') {
        expect(bytes.subarray(0, 3)).toEqual(Buffer.from('ffd8ff', 'hex'))
        expect(bytes.subarray(-2)).toEqual(Buffer.from('ffd9', 'hex'))
      } else {
        expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
        expect(bytes.toString('ascii', 8, 12)).toBe('WEBP')
        expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length)
      }
      expect(bytes.length).toBeGreaterThan(1024)
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'reply_completed' })), { timeout: 10_000 })
      const file = ((await session.query({ type: 'get_state' }))?.data as { sessionFile: string }).sessionFile
      const imageRef = () => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        .find(entry => entry.message?.role === 'user')?.message.content.find((part: { type: string }) => part.type === 'image')?.data
      await vi.waitFor(() => expect(imageRef()).toMatch(/^blob:sha256:[a-f0-9]{64}$/))
      const liveImages = await imagesInRuntime(session)
      expect(liveImages).toHaveLength(1)
      expect(Buffer.from(liveImages![0].data, 'base64')).toEqual(readFileSync(path.join(iso.agentDir, 'blobs', imageRef().slice(12))))
      const cold = await readSessionFileTranscript(file, { agentDir: iso.agentDir })
      expect(cold?.find(row => row.role === 'user')?.images).toEqual(liveImages)
      await cleanup!()
      const resumed = openSession(file)
      await vi.waitFor(() => expect(resumed.handshakeOutcome?.profile, stderr).toBe('current'), { timeout: 15_000 })
      const restored = await imagesInRuntime(resumed)
      expect(restored).toEqual(liveImages)
      if (process.platform === 'darwin') {
        // Verify both the exact HTTP payload and the reopened transcript can be
        // fully decoded, even when OMP stores and sends different containers.
        for (const [name, payload] of [['sent', bytes], ['restored', Buffer.from(restored![0].data, 'base64')]] as const) {
          const input = path.join(iso.root, name), output = path.join(iso.root, name + '.png')
          writeFileSync(input, payload)
          execFileSync('/usr/bin/sips', ['-s', 'format', 'png', input, '--out', output], { stdio: 'pipe' })
          const decoded = readFileSync(output)
          expect([decoded.readUInt32BE(16), decoded.readUInt32BE(20)]).toEqual([side, side])
        }
      }
    } finally {
      await cleanup?.()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      iso.cleanup()
    }
  }, 45_000)
})
