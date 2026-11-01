import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, dialog: {} }))
vi.mock('./omp', () => ({ detectCli: () => ({ command: 'omp', available: false }) }))
import { prepareIsolatedAiHome } from './htmlBoardAi'

describe('isolated AI runtime', () => {
  it('copies only permitted model settings and does not copy other user files', () => {
    const root=mkdtempSync(path.join(tmpdir(),'board-isolation-test-'))
    try {
      const source=path.join(root,'source'), home=path.join(root,'isolated'); mkdirSync(source); mkdirSync(home)
      writeFileSync(path.join(source,'config.yml'),YAML.stringify({modelRoles:{default:'provider/model'},mcp:{secret:'ignore'},packages:['unsafe']}))
      writeFileSync(path.join(source,'models.yml'),YAML.stringify({providers:{provider:{apiKey:'synthetic-key', unsafe:'ignore', models:[{id:'model',name:'Synthetic',secret:'ignore'}]}}}))
      writeFileSync(path.join(source,'mcp.json'),'sensitive')
      const env=prepareIsolatedAiHome(home,source,'provider/model')
      const cfg=readFileSync(path.join(home,'.omp','agent','config.yml'),'utf8')
      const models=readFileSync(path.join(home,'.omp','agent','models.yml'),'utf8')
      expect(cfg).toContain('provider/model'); expect(cfg).not.toContain('packages'); expect(cfg).not.toContain('mcp')
      expect(models).toContain('synthetic-key'); expect(models).not.toContain('unsafe'); expect(models).not.toContain('secret')
      expect(existsSync(path.join(home,'.omp','agent','mcp.json'))).toBe(false)
      expect(env.HOME).toBe(home); expect(env.PI_CODING_AGENT_DIR).toBe(path.join(home,'.omp','agent'))
    } finally { rmSync(root,{recursive:true,force:true}) }
  })
})
