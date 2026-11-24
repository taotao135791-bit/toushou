import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../omp', () => ({
  detectCli: () => ({ command: 'omp' }),
  getSession: vi.fn(),
  getSessionMessages: vi.fn()
}))

import { importSessionHistory } from '../sessionImport'
import { listAllSessions, listSessionHistory } from '../sessionHistory'
import { readSessionFileTranscript } from '../sessionTranscript'

const firstId = '11111111-2222-4333-8444-555555555555'
const secondId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const start = '2026-11-20T01:00:00.000Z'
const finish = '2026-11-20T01:05:00.000Z'

describe('import local agent conversation history', () => {
  let dir: string
  let workspace: string
  let defaultWorkspace: string
  let agentDir: string

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'toushou-agent-history-')))
    workspace = path.join(dir, 'project')
    defaultWorkspace = path.join(dir, 'default')
    agentDir = path.join(dir, 'agent')
    await mkdir(workspace)
    await mkdir(defaultWorkspace)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeJsonLines(file: string, records: object[]) {
    await mkdir(path.dirname(file), { recursive: true })
    const content = records.map(record => JSON.stringify(record)).join('\n') + '\n'
    await writeFile(file, content)
    return content
  }

  function importOptions(source: 'codex' | 'claude') {
    return { source, sourceDirectory: path.join(dir, source), agentDir, defaultWorkspace, projects: new Set([workspace]) }
  }

  it('rejects overlapping source and destination directories before writing', async () => {
    const options = importOptions('codex')
    const file = path.join(options.sourceDirectory, `rollout-2026-11-20T01-00-00-${firstId}.jsonl`)
    const original = await writeJsonLines(file, [
      { type: 'session_meta', payload: { id: firstId, cwd: workspace } },
      { type: 'event_msg', payload: { type: 'user_message', message: '原始对话' } }
    ])
    const nestedDestination = path.join(options.sourceDirectory, 'configured-agent')
    expect(await importSessionHistory({ ...options, agentDir: nestedDestination }))
      .toEqual({ ok: false, error: 'destination-unavailable' })
    await expect(stat(nestedDestination)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(file, 'utf8')).resolves.toBe(original)
  })

  it('imports a Codex project transcript once, keeps timestamps, and deduplicates wire records and archives', async () => {
    const options = importOptions('codex')
    const name = `rollout-2026-11-20T01-00-00-${firstId}.jsonl`
    const file = path.join(options.sourceDirectory, 'sessions', '2026', '11', '20', name)
    const journal = [
      { type: 'session_meta', timestamp: start, payload: { id: firstId, cwd: workspace, title: '本周消耗复盘' } },
      { type: 'response_item', timestamp: start, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>synthetic private context</environment_context>' }] } },
      { type: 'response_item', timestamp: start, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '汇总本周消耗' }] } },
      { type: 'event_msg', timestamp: start, payload: { type: 'user_message', message: '汇总本周消耗' } },
      { type: 'response_item', timestamp: start, payload: { type: 'function_call_output', output: 'synthetic private output' } },
      { type: 'response_item', timestamp: finish, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '合计 1200 美元' }] } },
      { type: 'event_msg', timestamp: finish, payload: { type: 'agent_message', message: '合计 1200 美元' } }
    ]
    const original = await writeJsonLines(file, journal)
    const archive = path.join(options.sourceDirectory, 'archived_sessions', name)
    await writeJsonLines(archive, journal)
    const originalMtime = (await stat(file)).mtimeMs
    const archiveMtime = (await stat(archive)).mtimeMs
    await expect(importSessionHistory(options)).resolves.toEqual({
      ok: true, imported: 1, duplicates: 1, skipped: 0, failed: 0, defaultWorkspace: 0, compressed: 0
    })
    const history = await listSessionHistory(workspace, agentDir)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ title: '本周消耗复盘', cwd: workspace, importedFrom: 'codex', timestamp: Date.parse(finish) })
    expect(history[0].uuid).not.toBe(firstId)
    const preview = await readSessionFileTranscript(history[0].filePath)
    expect(preview?.map(message => [message.role, message.content])).toEqual([
      ['user', '汇总本周消耗'], ['assistant', '合计 1200 美元']
    ])
    await expect(readFile(file, 'utf8')).resolves.toBe(original)
    await expect(importSessionHistory(options)).resolves.toMatchObject({ ok: true, imported: 0, duplicates: 2 })
    await expect(readFile(file, 'utf8')).resolves.toBe(original)
    await expect(readFile(archive, 'utf8')).resolves.toBe(original)
    expect((await stat(file)).mtimeMs).toBe(originalMtime)
    expect((await stat(archive)).mtimeMs).toBe(archiveMtime)
    expect(await listAllSessions(agentDir)).toHaveLength(1)
  })

  it('imports an older Codex response-only journal when generated context precedes the prompt', async () => {
    const options = importOptions('codex')
    await writeJsonLines(path.join(options.sourceDirectory, `rollout-2026-11-20-${firstId}.jsonl`), [
      { type: 'session_meta', timestamp: start, payload: { id: firstId, cwd: workspace } },
      { type: 'response_item', timestamp: start, payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '# AGENTS.md instructions for local project' },
        { type: 'input_text', text: 'Compare spend by currency' }
      ] } }
    ])
    await expect(importSessionHistory(options)).resolves.toMatchObject({ ok: true, imported: 1 })
    const [session] = await listSessionHistory(workspace, agentDir)
    const preview = await readSessionFileTranscript(session.filePath)
    expect(preview?.map(message => message.content)).toEqual(['Compare spend by currency'])
  })

  it('imports canonical Codex items and reports a compressed archive independently', async () => {
    const options = importOptions('codex')
    const completed = (item: object) => ({ type: 'event_msg', timestamp: finish, payload: { type: 'item_completed', item } })
    await writeJsonLines(path.join(options.sourceDirectory, `rollout-2026-11-20-${firstId}.jsonl`), [
      { type: 'session_meta', timestamp: start, payload: { id: firstId, cwd: workspace } },
      completed({ type: 'UserMessage', id: 'u', content: [{ type: 'text', text: '看留存' }] }),
      completed({ type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: '可看次日留存' }] }),
      completed({ type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: '可看次日留存' }] })
    ])
    await writeFile(path.join(options.sourceDirectory, `rollout-2026-11-20-${secondId}.jsonl.zst`), 'synthetic compressed file')
    await expect(importSessionHistory(options)).resolves.toMatchObject({ ok: true, imported: 1, failed: 1, compressed: 1 })
    const [session] = await listAllSessions(agentDir)
    expect((await readSessionFileTranscript(session.filePath))?.map(message => message.content)).toEqual(['看留存', '可看次日留存'])
  })

  it('keeps the main Claude branch and routes an unknown project to the default workspace', async () => {
    const options = importOptions('claude')
    const cwd = path.join(dir, 'unregistered')
    const item = (type: string, uuid: string, parentUuid: string | null, content: unknown, more = {}) => ({
      type, uuid, parentUuid, cwd, sessionId: firstId, timestamp: start, message: { role: type, content }, ...more
    })
    const file = path.join(options.sourceDirectory, 'projects', 'synthetic', firstId + '.jsonl')
    const original = await writeJsonLines(file, [
      item('user', 'user1', null, '开始分析'),
      item('assistant', 'a1', 'user1', [{ type: 'thinking', thinking: '隐私' }, { type: 'text', text: '开始' }]),
      item('user', 'stale', 'a1', '被放弃的分支'),
      item('assistant', 'stale-reply', 'stale', [{ type: 'text', text: '旧回答' }]),
      item('user', 'user2', 'a1', '只看 Android'),
      item('assistant', 'tool', 'user2', [{ type: 'tool_use', name: 'private-tool' }]),
      item('user', 'tool-result', 'tool', [{ type: 'tool_result', content: '不导入' }]),
      item('assistant', 'a2', 'tool-result', [{ type: 'text', text: 'Android 汇总' }], { timestamp: finish }),
      { type: 'custom-title', customTitle: 'Android 周报' }
    ])
    const originalMtime = (await stat(file)).mtimeMs
    await expect(importSessionHistory(options)).resolves.toEqual({
      ok: true, imported: 1, duplicates: 0, skipped: 0, failed: 0, defaultWorkspace: 1, compressed: 0
    })
    const [session] = await listSessionHistory(defaultWorkspace, agentDir)
    expect(session).toMatchObject({ title: 'Android 周报', cwd: defaultWorkspace, importedFrom: 'claude', timestamp: Date.parse(finish) })
    const messages = await readSessionFileTranscript(session.filePath)
    expect(messages?.map(message => message.content)).toEqual(['开始分析', '开始', '只看 Android', 'Android 汇总'])
    await expect(importSessionHistory({ ...options, projects: new Set([cwd]) })).resolves.toMatchObject({ ok: true, imported: 0, duplicates: 1 })
    await expect(readFile(file, 'utf8')).resolves.toBe(original)
    expect((await stat(file)).mtimeMs).toBe(originalMtime)
  })

  it('reports malformed files without hiding successful imports and does not follow child symlinks', async () => {
    const options = importOptions('claude')
    const selectedProject = path.join(options.sourceDirectory, 'projects', 'readable')
    const outside = path.join(dir, 'outside')
    await mkdir(outside)
    await mkdir(selectedProject, { recursive: true })
    await symlink(outside, path.join(options.sourceDirectory, 'projects', 'untrusted'), 'junction')
    await writeJsonLines(path.join(outside, 'dddddddd-eeee-4fff-8000-111111111111.jsonl'), [{ type: 'user', message: { content: 'outside the selected directory' } }])
    await writeFile(path.join(selectedProject, firstId + '.jsonl'), '{broken file')
    await writeJsonLines(path.join(selectedProject, secondId + '.jsonl'), [
      { type: 'user', message: { content: 'valid user message' }, cwd: workspace, timestamp: start }
    ])
    await expect(importSessionHistory(options)).resolves.toMatchObject({ ok: true, imported: 1, failed: 1 })
    const [session] = await listAllSessions(agentDir)
    expect(session.title).toBe('valid user message')
  })
})
