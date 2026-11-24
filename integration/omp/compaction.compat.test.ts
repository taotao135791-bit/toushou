import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it, vi } from 'vitest'
import { createIsolatedOmpEnvironment, binaryAvailable, requireBinary } from './isolated-runtime'
import { OmpSession, type OmpProcessLike } from '../../src/main/omp/OmpSession'
import { desktopCompactionPolicy } from '../../src/shared/compaction'
import type { SessionEvent } from '../../src/shared/types'

describe('OMP compaction in a live RPC session', () => {
  it('applies model-relative thresholds, persists a summary, keeps recent turns and accepts a follow-up', async () => {
    const bin = process.env.OMP_BIN || 'omp'
    if (!binaryAvailable(bin)) { requireBinary(bin); return }
    const iso = createIsolatedOmpEnvironment()
    const file = path.join(iso.root, 'policy.json')
    const policy = (percent: number) => writeFileSync(file, JSON.stringify(desktopCompactionPolicy(percent)))
    policy(80)
    Object.assign(iso.env, { TOUSHOU_CONTEXT_POLICY: file, OMP_PROFILE: 'default', USERPROFILE: iso.homeDir,
      XDG_CONFIG_HOME: iso.homeDir, APPDATA: iso.homeDir, LOCALAPPDATA: iso.homeDir })
    let rejectSummaries = false
    let holdSummaries = false
    let heldRequests = 0
    const requests: string[] = []
    const summaries: string[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const { messages, model } = JSON.parse(Buffer.concat(chunks).toString())
      const text = JSON.stringify(messages)
      const isSummary = text.includes('<conversation>')
      if (isSummary && holdSummaries) {
        heldRequests++
        res.writeHead(200, {'content-type':'text/event-stream'})
        res.flushHeaders()
        return // Wait for native AbortController to close this response.
      }
      if (isSummary && rejectSummaries) {
        res.writeHead(400, {'content-type':'application/json'})
        res.end(JSON.stringify({error:{message:'Fixture summary unavailable'}}))
        return
      }
      if (isSummary) summaries.push(text)
      else requests.push(text)
      const answer = isSummary ? 'Earlier brief: campaign Indigo, target 11.' : 'Noted.'
      // Report input usage for the actual request (including prompt and history).
      const input = Math.ceil(text.length / 4)
      const event = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model,
        usage: {prompt_tokens:input,completion_tokens:3,total_tokens:input+3},
        choices: [{index:0,delta:{content:answer},finish_reason:'stop'}] }
      res.writeHead(200, {'content-type':'text/event-stream'})
      res.end('data: '+JSON.stringify(event)+'\n\ndata: [DONE]\n\n')
    })
    let close: (() => Promise<void>) | undefined
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('Missing fixture port')
      writeFileSync(path.join(iso.agentDir, 'models.yml'), JSON.stringify({providers:{fixture:{
        baseUrl:'http://127.0.0.1:'+address.port+'/v1', api:'openai-completions', apiKey:'fixture',
        models:[{id:'medium',contextWindow:48000,maxTokens:2048},{id:'large',contextWindow:96000,maxTokens:2048}]
      }}}))
      writeFileSync(path.join(iso.agentDir,'config.yml'),JSON.stringify({
        modelRoles:{default:'fixture/medium',smol:'fixture/medium',slow:'fixture/medium'},
        compaction:{keepRecentTokens:4000, strategy:'off', modelThresholds:{'fixture/large':'95%'}}
      }))
      const events: SessionEvent[] = []
      const completed = () => events.filter(e => e.type === 'compaction' && e.outcome === 'compacted').length
      const proc = iso.spawnRpc(bin,['--model','fixture/medium','--config',file,'--no-tools','--no-skills','--no-rules','--no-title',
        '-e',path.resolve('resources/context-policy/index.ts')])
      const exited = new Promise<void>(resolve=>proc.once('close',()=>resolve()))
      const session = new OmpSession({id:'probe',cwd:iso.agentDir,title:'',createdAt:0,status:'idle'},
        proc as unknown as OmpProcessLike,{onEvent:event=>events.push(event)})
      close = async () => {session.kill(); await exited}
      const query = async (command: Record<string, unknown>) => {
        const res = await session.query(command,15000)
        expect(res?.success, JSON.stringify(res)).toBe(true)
        return res?.data as Record<string,unknown>
      }
      const stats = async () => {
        const result = await session.getSessionStats()
        if (!result) throw Error('No session usage returned')
        return result
      }
      const send = async (message: string) => {
        const previous = events.length
        expect(session.sendPrompt(message)).toBe(true)
        expect(await session.compact()).toBe(false) // Already submitted, before agent_start.
        await vi.waitFor(()=>expect(events.slice(previous).some(e=> e.type==='status' && e.status==='idle')).toBe(true),
          {timeout:20000,interval:20})
      }
      const state = await query({type:'get_state'})
      expect(await session.compact()).toBe(true)
      expect(events).toContainEqual(expect.objectContaining({type:'compaction',reason:'too_small'}))
      const payload = ' sample metric'.repeat(1300)
      let pct = 0
      // OMP can request speculative summaries below the threshold. Only a committed
      // compaction changes the conversation that the next prompt will use.
      for (let i=0; i<20 && !completed(); i++) {
        await send((i===0?'Original campaign Indigo, target 11. ': '')+'Turn '+i+' '+payload)
        const use = (await stats()).contextUsage
        expect(use?.contextWindow).toBe(48000)
        if (!completed()) pct = use?.percent ?? 0
      }
      expect(completed()).toBe(1)
      expect(pct).toBeGreaterThan(60)
      expect(pct).toBeLessThanOrEqual(80)
      console.info('Before default 80% compaction:', pct.toFixed(2)+'% of 48000')
      expect(summaries.some(text=>text.includes('Original campaign Indigo'))).toBe(true)
      await send('After the automatic summary')
      expect(requests.at(-1)).toContain('Earlier brief: campaign Indigo')
      expect(requests.at(-1)).toContain(' sample metric')
      expect(requests.at(-1)).not.toContain('Original campaign Indigo')
      expect(completed()).toBe(1)
      expect(readFileSync(String(state.sessionFile),'utf8')).toContain('"type":"compaction"')

      await query({type:'set_model',provider:'fixture',modelId:'large'})
      expect((await stats()).contextUsage?.contextWindow).toBe(96000)
      policy(95)
      for (let i=0; i<30 && ((await stats()).contextUsage?.percent ?? 0)<58; i++) await send('New model '+i+payload)
      expect(completed()).toBe(1)
      const beforeLowering = (await stats()).contextUsage?.percent ?? 0
      expect(beforeLowering).toBeGreaterThan(50)
      expect(beforeLowering).toBeLessThan(95)
      console.info('Live model switch: 96000 tokens, used '+beforeLowering.toFixed(2)+'% under 95% setting; lowering to 50%')
      policy(50)
      await send('Updated threshold in the same conversation')
      expect(completed()).toBe(2)
      expect((await stats()).contextUsage?.percent).toBeLessThan(50)
      await send('Follow-up after threshold change')
      expect(completed()).toBe(2)
      expect(requests.at(-1)).toContain('Follow-up after threshold change')
      const immediate = session.compact()
      expect(session.abort()).toBe(true)
      expect(await immediate).toBe(true)
      expect(events.at(-1)).toMatchObject({ type:'compaction',source:'manual',phase:'end',outcome:'aborted' })

      // The RPC accepts manual compaction after a normal turn and releases the lock on completion.
      await send('Manual-test context '+payload)
      expect(await session.compact()).toBe(true)
      expect(completed()).toBe(3)
      await send('Continue after manual compaction')
      expect(requests.at(-1)).toContain('Continue after manual compaction')
      await send('Check provider failure '+payload)
      const beforeFailure = events.length
      rejectSummaries = true
      expect(await session.compact()).toBe(false)
      expect(events.slice(beforeFailure)).toContainEqual(expect.objectContaining({
        type:'compaction',source:'manual',phase:'end',outcome:'failed'
      }))
      rejectSummaries = false
      await send('Continue after the rejected summary')
      expect(requests.at(-1)).toContain('Continue after the rejected summary')
      await send('Cancellation fixture '+payload)
      holdSummaries = true
      const beforeCancel = events.length
      const pending = session.compact()
      await vi.waitFor(() => expect(heldRequests).toBeGreaterThan(0), {timeout:5000, interval:20})
      expect(session.abort()).toBe(true)
      expect(await pending).toBe(true)
      expect(events.slice(beforeCancel)).toContainEqual(expect.objectContaining({
        type:'compaction',source:'manual',phase:'end',outcome:'aborted'
      }))
      holdSummaries = false
      await send('Continue after manual cancellation')
      expect(requests.at(-1)).toContain('Continue after manual cancellation')
      expect(parse(readFileSync(path.join(iso.agentDir,'config.yml'),'utf8')).compaction)
        .toEqual({keepRecentTokens:4000, strategy:'off', modelThresholds:{'fixture/large':'95%'}})
    } finally {
      await close?.()
      server.closeAllConnections()
      await new Promise<void>(resolve=>server.close(()=>resolve()))
      iso.cleanup()
    }
  })
})
