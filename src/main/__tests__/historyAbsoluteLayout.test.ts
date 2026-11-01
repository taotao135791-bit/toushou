import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const home = vi.hoisted(() => ({ value: '', temp: '' }))
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => home.value || actual.homedir(), tmpdir: () => home.temp || actual.tmpdir() }
})
vi.mock('../piSettings', () => ({ defaultPiAgentDir: () => '' }))

import { hashedSessionDirCandidatesFor, listAllSessions, listSessionHistory, sessionDirCandidatesFor } from '../sessionHistory'
import { HistorySessionGrantManager } from '../historySessionGrant'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(tmpdir(), 'history-layout-')); home.value = path.join(root, 'home') })
afterEach(() => { home.value = ''; home.temp = ''; fs.rmSync(root, { recursive: true, force: true }) })

describe('current OMP absolute project layout', () => {
  it('discovers and authorizes a CJK project outside HOME while rejecting other workspaces', async () => {
    const workspace = path.join(root, 'outside', '项目')
    const other = path.join(root, 'other', '项目')
    const agent = path.join(home.value, '.omp', 'agent')
    for (const dir of [home.value, workspace, other]) fs.mkdirSync(dir, { recursive: true })
    const canonical = fs.realpathSync(workspace)
    expect(path.relative(fs.realpathSync(home.value), canonical).startsWith('..')).toBe(true)
    const hash = createHash('sha256').update(canonical).digest('hex')
    const directory = path.join(agent, 'sessions', `abs-project-${hash}`)
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, 'synthetic.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'synthetic-history', timestamp: 1, cwd: workspace }) + '\n')

    const candidates = hashedSessionDirCandidatesFor(workspace, agent)
    expect(candidates).toContain(directory)
    expect(new Set(candidates).size).toBe(candidates.length)
    expect((await listAllSessions(agent))[0].cwd).toBe(fs.realpathSync.native(workspace))
    const rows = await listSessionHistory(workspace, agent)
    expect(rows).toHaveLength(1)
    expect(await listSessionHistory(other, agent)).toEqual([])

    const manager = new HistorySessionGrantManager({ agentDir: agent })
    const context = { workspaceGrantId: 'project-grant', workspaceRealPath: canonical, ownerWebContentsId: 41 }
    const otherContext = { ...context, workspaceGrantId: 'other-grant', workspaceRealPath: fs.realpathSync(other) }
    expect(await manager.mintForWorkspace(rows, otherContext)).toEqual([])
    const [descriptor] = await manager.mintForWorkspace(rows, context)
    expect(descriptor).toBeDefined()
    expect(await manager.resolve(descriptor.id, otherContext)).toBeNull()
    expect(await manager.withResolved(descriptor.id, context, async target => fs.realpathSync.native(target))).toBe(fs.realpathSync.native(file))
  })
})

describe('OMP 17.2.12 directory layouts', () => {
  it('lists and authorizes the runtime default and older hash layouts without crossing workspaces', async () => {
    const workspace = path.join(root, 'outside', '测试 report')
    const other = path.join(root, 'other', '测试 report')
    const agent = path.join(home.value, '.omp', 'agent')
    for (const dir of [home.value, workspace, other]) fs.mkdirSync(dir, { recursive: true })
    const canonical = fs.realpathSync.native(workspace)
    // This fixture is below the real OS temp root but outside the mocked HOME:
    // OMP's temp-relative default and old hashed scope must both be readable.
    const temp = fs.realpathSync.native(tmpdir())
    const relative = path.relative(temp, canonical)
    expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy()
    const encoded = `-tmp-${relative.replace(/[/\\:]/g, '-')}`
    const label = path.basename(canonical).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'project'
    const hash = createHash('sha256').update(canonical.replaceAll('\\', '/')).digest('hex')
    const expectedDirs = [encoded, `tmp-${label}-${hash}`]
    for (const [index, name] of expectedDirs.entries()) {
      const directory = path.join(agent, 'sessions', name)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, `case-${index}.jsonl`), JSON.stringify({ type: 'session', id: `history-${index}`, timestamp: index + 1, cwd: workspace }) + '\n')
    }
    const rows = await listSessionHistory(canonical, agent)
    expect(rows).toHaveLength(2)
    expect(await listSessionHistory(other, agent)).toEqual([])
    expect((await listAllSessions(agent)).map(row => row.cwd)).toEqual([canonical, canonical])
    const manager = new HistorySessionGrantManager({ agentDir: agent })
    const context = { workspaceGrantId: 'current-project', workspaceRealPath: canonical, ownerWebContentsId: 17 }
    const otherContext = { ...context, workspaceGrantId: 'different-project', workspaceRealPath: fs.realpathSync.native(other) }
    expect(await manager.mintForWorkspace(rows, otherContext)).toEqual([])
    const descriptors = await manager.mintForWorkspace(rows, context)
    expect(descriptors).toHaveLength(2)
    for (const descriptor of descriptors) {
      expect(await manager.resolve(descriptor.id, otherContext)).toBeNull()
      expect(await manager.withResolved(descriptor.id, context, async target => path.basename(target))).toMatch(/^case-[01]\.jsonl$/)
    }
  })
})

it('includes exact OMP default and hashed names for HOME and absolute projects', () => {
  home.temp = path.join(root, 'separate-temp')
  const projects = [path.join(home.value, 'a', 'My 中文 Project'), path.join(root, 'outside', 'My 中文 Project')]
  for (const dir of [home.temp, ...projects]) fs.mkdirSync(dir, { recursive: true })
  const agent = path.join(root, 'agent')
  for (const [index, project] of projects.entries()) {
    const cwd = fs.realpathSync.native(project)
    const relative = path.relative(fs.realpathSync.native(home.value), cwd)
    const encoded = index === 0 ? `-${relative.replace(/[/\\:]/g, '-')}` : `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
    const hash = createHash('sha256').update(cwd.replaceAll('\\', '/')).digest('hex')
    const candidates = sessionDirCandidatesFor(cwd, agent)
    expect(candidates).toContain(path.join(agent, 'sessions', encoded))
    expect(candidates).toContain(path.join(agent, 'sessions', `${index === 0 ? 'home' : 'abs'}-My-Project-${hash}`))
  }
})
