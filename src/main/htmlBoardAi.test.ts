import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { ChildProcess, spawn } from 'node:child_process'
import { renderHtmlBoard, type HtmlBoardDocument } from '../shared/htmlBoard'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, dialog: {} }))
vi.mock('./omp', () => ({ detectCli: () => ({ command: 'omp', path: '/fake/omp', available: true }) }))
import { fullAiSnapshot, requestHtmlBoardAiEdit, cancelHtmlBoardAiEdit, cancelOwnerHtmlBoardAiEdits } from './htmlBoardAi'

const snapshot = {kind:'reading-snapshot',version:1,rangeLabel:'sensitive label',window:{start:'2026-01-01',end:'2026-01-07'},capturedAt:1000,accounts:[{platform:'tiktok',accountId:'999999999999',name:'Private Account Name',status:'ok',statusDetail:'private failure detail',window:{start:'2026-01-01',end:'2026-01-07'},previousWindow:null,sourceAt:900,timezone:'private timezone',currency:'USD',spend:42,previousSpend:null,impressions:100,clicks:2,conversions:1,resultType:'private result definition'}]}
const document = { schemaVersion:1, id:'doc', revision:1, source:{boardId:'board',widgetId:'widget',snapshotHash:'a'.repeat(64)},snapshot,includeChart:false,createdAt:1,updatedAt:1, html:'<header class="client_secret"><h1 title="private title">Private account &amp; detail</h1><!-- secret comment --></header><div data-reading-slot></div><p aria-label="private label">Revenue 999</p>', css:'.client_secret { color: red; font-family: privatefamily; padding: 12px; }', theme:'editorial' } as HtmlBoardDocument
const input = { id:'doc', expectedRevision:1, instruction:'change the look', requestId:'req' }
const cli = () => ({command:'omp' as const, path:'/fake/omp', available:true})
const read = () => ({ok:true as const, document})
function setup(reply: (layout: {html:string;css:string;theme:string}) => unknown, delayed = false, streamingEvents = 0) {
  let child: EventEmitter & {stdout:EventEmitter;stderr:EventEmitter;kill:ReturnType<typeof vi.fn>}
  let prompt = '', args: string[] = [], env: NodeJS.ProcessEnv = {}
  const fake = vi.fn((_cmd: unknown, received: unknown, options: unknown) => {
    args = received as string[]
    const opts = options as {cwd:string;env:NodeJS.ProcessEnv}; env = opts.env
    prompt = readFileSync(`${opts.cwd}/prompt.md`,'utf8')
    child = Object.assign(new EventEmitter(), {stdout:new EventEmitter(), stderr:new EventEmitter(), kill:vi.fn(() => { child.emit('close', null); return true })})
    if (!delayed) queueMicrotask(() => {
      const layout = JSON.parse(prompt.split('Current layout: ')[1])
      const answer = reply(layout)
      const event = { type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:typeof answer === 'string' ? answer : JSON.stringify(answer)}]}}
      if (streamingEvents) {
        const updates = Buffer.from((JSON.stringify({type:'message_update',delta:'界'.repeat(40)})+'\n').repeat(streamingEvents))
        for (let i=0;i<updates.length;i+=137) child.stdout.emit('data',updates.subarray(i,i+137))
      }
      child.stdout.emit('data', Buffer.from(JSON.stringify(event)+'\n')); child.emit('close',0)
    })
    return child as unknown as ChildProcess
  }) as unknown as typeof spawn
  return { fake, getPrompt:()=>prompt, getArgs:()=>args, getEnv:()=>env }
}

describe('AI layout privacy and proposals', () => {
  it('sends at most fifty chosen accounts with names and IDs while excluding error details', () => {
    const data = { ...snapshot, accounts:Array.from({length:52},()=>snapshot.accounts[0]) }
    const result = fullAiSnapshot(data)
    expect(result.accounts).toHaveLength(50)
    expect(result.omittedCount).toBe(2)
    expect(result.accounts[0]).toMatchObject({index:1,platform:'tiktok',status:'ok',metrics:{spend:42},name:'Private Account Name',accountId:'999999999999',resultType:'private result definition'})
    for (const secret of ['private failure detail','sensitive label']) expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('fails closed when the OMP runtime is unavailable', async () => {
    const unavailable = () => ({ command:'omp' as const, available:false })
    expect(await requestHtmlBoardAiEdit(input,{owner:1,read,cli:unavailable})).toEqual({ok:false,error:'unavailable'})
  })
  it('passes only a private prompt file to mock CLI and returns a local review proposal', async () => {
    const s=setup(layout=>layout)
    const result=await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:s.fake})
    expect(result.ok).toBe(true)
    expect(s.getArgs()).toEqual(expect.arrayContaining(['--no-tools','--no-extensions','--no-skills','--no-rules','--no-session','@prompt.md']))
    expect(s.getPrompt()).toContain('Private account')
    expect(s.getPrompt()).toContain('client_secret')
    expect(s.getPrompt()).toContain('Revenue 999')
    expect(s.getPrompt()).toContain('999999999999')
    expect(s.getPrompt()).toContain('Private Account Name')
    expect(s.getPrompt()).toContain('private result definition')
    expect(s.getPrompt()).toContain('\"spend\":42')
    expect(s.getPrompt()).toContain('data-reading-value')
    expect(Object.keys(s.getEnv()).some(k=>/^TOUSHOU_/i.test(k)||/BRIDGE/i.test(k))).toBe(false)
    if (result.ok) expect(result.proposal.html).toContain('Private account')
  })
  it('rejects obvious credentials in the instruction before launching', async () => {
    const s=setup(layout=>layout)
    expect(await requestHtmlBoardAiEdit({...input,instruction:'Use sk-syntheticcredentials12345'},{owner:1,read,cli,spawn:s.fake})).toEqual({ok:false,error:'sensitive-content'})
    expect(s.fake).not.toHaveBeenCalled()
  })
  it('accepts valid bound metrics, rejects unknown accounts, and passes selected model as a literal argument', async () => {
    const bound=setup(layout=>({...layout,html:layout.html+'<p>Spend <span data-reading-value=\"1.spend\"></span></p><div data-reading-chart=\"spend\"></div>'}))
    const result=await requestHtmlBoardAiEdit({...input,modelSelector:'deepseek/deepseek-v4-flash'},{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:bound.fake})
    expect(result.ok).toBe(true)
    if (result.ok) {
      const before = structuredClone(document)
      const html = renderHtmlBoard({...document,html:result.proposal.html,css:result.proposal.css,theme:result.proposal.theme},{anonymize:false})
      expect(html).toContain('Private Account Name')
      expect(html).toContain('42')
      expect(document).toEqual(before)
    }
    expect(bound.getArgs()).toEqual(expect.arrayContaining(['--model','deepseek/deepseek-v4-flash']))
    const unknown=setup(layout=>({...layout,html:layout.html+'<span data-reading-value=\"2.spend\"></span>'}))
    expect(await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:unknown.fake})).toEqual({ok:false,error:'invalid-output'})
    expect(await requestHtmlBoardAiEdit({...input,modelSelector:'--bad'},{owner:1,read,cli})).toEqual({ok:false,error:'invalid-input'})
  })
  it('accepts one pure JSON fence as a review-only proposal but rejects unsupported styles and commentary', async () => {
    const savedBefore = structuredClone(document)
    const fenced=setup(layout=>'```json\n'+JSON.stringify({...layout,html:layout.html+'<p>Updated</p>'})+'\n```')
    const result=await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:fenced.fake})
    expect(result.ok).toBe(true)
    expect(document).toEqual(savedBefore)
    expect(fenced.getPrompt()).toContain('Allowed CSS properties:')
    expect(fenced.getPrompt()).toContain('No negative numbers')
    const invalid=setup(layout=>({...layout,css:'.hero { box-shadow: 0 0 8px red; }'}))
    expect(await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:invalid.fake})).toEqual({ok:false,error:'invalid-output'})
    const commentary=setup(layout=>'Here is your board:\n```json\n'+JSON.stringify(layout)+'\n```')
    expect(await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:commentary.fake})).toEqual({ok:false,error:'invalid-output'})
    expect(document).toEqual(savedBefore)
  })
  it('ignores extra model fields and retains the current theme when omitted or unknown', async () => {
    const s=setup(layout=>({html:layout.html,css:layout.css,theme:'custom',explanation:'extra'}))
    const result=await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:s.fake})
    expect(result).toMatchObject({ok:true,proposal:{theme:document.theme}})
    if (result.ok) expect(Object.keys(result.proposal).sort()).toEqual(['baseRevision','css','html','theme'])
  })
  it('rejects malformed output and changes made while the model was working', async () => {
    const bad=setup(layout=>({...layout,html:'<script>x</script><div data-reading-slot></div>'}))
    expect(await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:bad.fake})).toEqual({ok:false,error:'invalid-output'})
    let count=0
    const stale=setup(layout=>layout)
    const staleRead = () => ({ok:true as const,document:{...document,revision:++count === 1 ? 1 : 2}})
    expect(await requestHtmlBoardAiEdit(input,{owner:1,read:staleRead,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:stale.fake})).toEqual({ok:false,error:'conflict'})
  })
  it('limits concurrent requests and times out a stalled child', async () => {
    const s=setup(layout=>layout,true)
    const pending=requestHtmlBoardAiEdit(input,{owner:7,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:s.fake,timeoutMs:20})
    await Promise.resolve()
    expect(await requestHtmlBoardAiEdit({...input,requestId:'other'},{owner:7,read,cli,spawn:s.fake})).toEqual({ok:false,error:'busy'})
    expect(await pending).toEqual({ok:false,error:'timeout'})
  })
  it('accepts a bounded final response after over 256 KB of streaming UTF-8 events', async () => {
    const s=setup(layout=>layout,false,3000)
    expect(await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:s.fake})).toMatchObject({ok:true})
  })
  it('rejects an oversized provider response', async () => {
    const s=setup(layout=>({...layout,html:'x'.repeat(300_000)}))
    expect(await requestHtmlBoardAiEdit(input,{owner:1,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:s.fake})).toEqual({ok:false,error:'invalid-output'})
  })
  it('binds cancellation to the owner and stops in-flight work', async () => {
    const s=setup(layout=>layout,true)
    const pending=requestHtmlBoardAiEdit(input,{owner:3,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:s.fake})
    await Promise.resolve()
    expect(cancelHtmlBoardAiEdit('req',4)).toBe(false)
    expect(cancelHtmlBoardAiEdit('req',3)).toBe(true)
    expect(await pending).toEqual({ok:false,error:'cancelled'})
    const pending2=requestHtmlBoardAiEdit({...input,requestId:'req2'},{owner:3,read,cli,sourceAgent:'/nonexistent-test-model-dir',defaultModel:async()=>'',spawn:s.fake})
    await Promise.resolve()
    cancelOwnerHtmlBoardAiEdits(3)
    expect(await pending2).toEqual({ok:false,error:'cancelled'})
  })
})
