import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
vi.mock('./piSettings', () => ({ defaultPiAgentDir: () => '/unused' }))
import { discoverProjectSessionFiles } from './projectSessionFiles'
import { sessionDirCandidatesFor } from './sessionHistory'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe('project transcript ownership', () => {
  it('discovers multiple layouts from header cwd while excluding other projects and symlinks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-files-test-')); roots.push(root)
    const project = path.join(root, 'p'); const other = path.join(root, 'q'); const agent = path.join(root, 'agent')
    fs.mkdirSync(project); fs.mkdirSync(other)
    const sessions = path.join(agent, 'sessions'); fs.mkdirSync(sessions, { recursive: true })
    for (const dir of ['layout-one', 'layout-two']) fs.mkdirSync(path.join(sessions, dir))
    const write = (dir: string, name: string, cwd: string) => fs.writeFileSync(path.join(sessions, dir, name), JSON.stringify({type:'session', id:'same-id', cwd}) + '\n')
    write('layout-one', 'a.jsonl', fs.realpathSync.native(project)); write('layout-two', 'copy.jsonl', fs.realpathSync.native(project)); write('layout-two', 'other.jsonl', other)
    fs.symlinkSync(path.join(sessions, 'layout-one'), path.join(sessions, 'unsafe-link'), process.platform === 'win32' ? 'junction' : 'dir')
    const files = await discoverProjectSessionFiles(fs.realpathSync.native(project), agent)
    expect(files.map(f => path.basename(f.path)).sort()).toEqual(['a.jsonl', 'copy.jsonl'])
  })
  it('refuses malformed files in an expected project layout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-files-test-')); roots.push(root)
    const project = path.join(root, 'p'); const agent = path.join(root, 'agent'); fs.mkdirSync(project)
    const dir = sessionDirCandidatesFor(fs.realpathSync.native(project), agent)[0]; fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(path.join(dir, 'bad.jsonl'), 'bad')
    await expect(discoverProjectSessionFiles(fs.realpathSync.native(project), agent)).rejects.toThrow('unreadable-session-header')
  })
})
