import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./piSettings', () => ({ defaultPiAgentDir: () => '/unused-synthetic-agent' }))
import { sessionDirFor } from './sessionHistory'
import { taskSessionBelongsToWorkspace } from './taskSessionReuse'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'task-reuse-'))
  roots.push(root)
  const workspace = path.join(root, 'project-a'), other = path.join(root, 'project-b'), agent = path.join(root, 'agent')
  mkdirSync(workspace); mkdirSync(other)
  const directory = sessionDirFor(workspace, agent)
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'synthetic-session.jsonl')
  const write = (cwd: string) => writeFileSync(file, `${JSON.stringify({ type: 'title', title: 'synthetic' })}\n${JSON.stringify({ type: 'session', id: 'synthetic', cwd })}\n`)
  write(workspace)
  return { root, workspace, other, agent, file, write }
}

describe('task session workspace validation', () => {
  it('accepts an existing transcript from the exact workspace and rejects another workspace', async () => {
    const f = fixture()
    expect(await taskSessionBelongsToWorkspace(f.file, f.workspace, f.agent)).toBe(true)
    expect(await taskSessionBelongsToWorkspace(f.file, f.other, f.agent)).toBe(false)
    expect(await taskSessionBelongsToWorkspace(path.join(f.root, 'missing.jsonl'), f.workspace, f.agent)).toBe(false)
  })

  it('rejects a workspace-mismatched or malformed session header even inside the correct directory', async () => {
    const f = fixture()
    f.write(f.other)
    expect(await taskSessionBelongsToWorkspace(f.file, f.workspace, f.agent)).toBe(false)
    writeFileSync(f.file, '{"type":"title"}\n{"type":"session","id":"synthetic"}\n')
    expect(await taskSessionBelongsToWorkspace(f.file, f.workspace, f.agent)).toBe(false)
  })

  it('rejects files outside the runtime root and symlinks escaping it', async () => {
    const f = fixture(), external = path.join(f.root, 'external.jsonl')
    writeFileSync(external, `${JSON.stringify({ type: 'session', id: 'synthetic', cwd: f.workspace })}\n`)
    expect(await taskSessionBelongsToWorkspace(external, f.workspace, f.agent)).toBe(false)
    if (process.platform !== 'win32') {
      const link = path.join(path.dirname(f.file), 'escape.jsonl')
      symlinkSync(external, link)
      expect(await taskSessionBelongsToWorkspace(link, f.workspace, f.agent)).toBe(false)
    }
  })
})
