import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => home.value || actual.homedir() }
})
vi.mock('../piSettings', () => ({ defaultPiAgentDir: () => '' }))

import { hashedSessionDirCandidatesFor, listAllSessions, listSessionHistory } from '../sessionHistory'
import { HistorySessionGrantManager } from '../historySessionGrant'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(tmpdir(), 'history-layout-')); home.value = path.join(root, 'home') })
afterEach(() => { home.value = ''; fs.rmSync(root, { recursive: true, force: true }) })

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
    expect((await listAllSessions(agent))[0].cwd).toBe(canonical)
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
    expect(await manager.withResolved(descriptor.id, context, async target => fs.realpathSync(target))).toBe(fs.realpathSync(file))
  })
})
