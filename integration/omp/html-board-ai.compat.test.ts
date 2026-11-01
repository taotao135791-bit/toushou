import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawnCommand, spawnCommandSync } from '../../src/main/command'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, dialog: {} }))
vi.mock('../../src/main/omp', () => ({ detectCli: () => ({ command: 'omp', available: false }) }))
import { prepareIsolatedAiHome } from '../../src/main/htmlBoardAi'

describe('AI runtime compatibility', () => {
  it('pinned OMP does not launch ambient MCP or offer tools with a synthetic local provider', async () => {
    const root=mkdtempSync(path.join(tmpdir(),'board-omp-probe-'))
    const source=path.join(root,'source'),home=path.join(root,'isolated'),marker=path.join(root,'mcp launched marker')
    mkdirSync(source);mkdirSync(home)
    const server=createServer((req,res)=>{
      let body=''; req.on('data',chunk=>{body+=chunk}); req.on('end',()=>{
        try { requests.push(JSON.parse(body)) } catch { /* probe rejects missing request */ }
        res.writeHead(200,{'content-type':'text/event-stream'})
        const event={id:'synthetic',object:'chat.completion.chunk',created:1,model:'fake',choices:[{index:0,delta:{content:'{"html":"<div data-reading-slot></div>","css":"","theme":"minimal"}'},finish_reason:'stop'}]}
        res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`)
      })
    })
    const requests: Array<Record<string,unknown>>=[]
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    try {
      const address=server.address(); if (!address || typeof address==='string') throw Error('missing address')
      writeFileSync(path.join(source,'models.yml'),YAML.stringify({providers:{localtest:{baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'synthetic',models:[{id:'fake',name:'Synthetic',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1024}]}}}))
      const markerArgs = ['-e', "require('node:fs').writeFileSync(process.argv[1], '1')", marker]
      writeFileSync(path.join(source,'mcp.json'),JSON.stringify({mcpServers:{probe:{command:process.execPath,args:markerArgs}}}))
      const env=prepareIsolatedAiHome(home,source)
      const positiveControl = spawnCommandSync(process.execPath, markerArgs, {cwd:root,env,stdio:'ignore'})
      expect(positiveControl.status).toBe(0)
      expect(existsSync(marker)).toBe(true)
      unlinkSync(marker)
      for(const k of Object.keys(env)) if(k.endsWith('_API_KEY')) delete env[k]
      writeFileSync(path.join(root,'prompt.md'),'Return a short test response.',{mode:0o600})
      const result=await new Promise<{code:number|null;stderr:string;stdout:string}>((resolve,reject)=>{
        const child=spawnCommand(process.env.OMP_BIN || 'omp',['--mode','json','--print','--no-session','--no-tools','--no-extensions','--no-skills','--no-rules','--no-lsp','--no-pty','--no-title','--max-time=20','--thinking=low','--model','localtest/fake','@prompt.md'],{cwd:root,env,stdio:['ignore','pipe','pipe']})
        let stderr='',stdout='';child.stdout?.on('data',chunk=>{stdout+=String(chunk)});child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-16384)})
        child.on('error',reject);child.on('close',code=>resolve({code,stderr:stderr.slice(-16384),stdout}))
      })
      expect(result.code, result.stderr).toBe(0)
      expect(requests.length).toBeGreaterThan(0)
      const events=result.stdout.trim().split('\n').map(line=>JSON.parse(line))
      expect(events.some(event=>event.type==='message_end' && event.message?.role==='assistant' && event.message?.content?.some((part:{type:string})=>part.type==='text'))).toBe(true)
      expect(requests.every(req=>!Array.isArray(req.tools) || req.tools.length===0)).toBe(true)
      expect(existsSync(marker)).toBe(false)
    } finally { server.close(); rmSync(root,{recursive:true,force:true}) }
  }, 30000)
})
