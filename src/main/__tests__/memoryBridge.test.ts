import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const agentDir = mkdtempSync(path.join(tmpdir(), 'memory-bridge-agent-'))
const stableUserData = mkdtempSync(path.join(tmpdir(), 'memory-bridge-user-'))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => stableUserData }
}))
// NOTE: path relative to THIS test file — a wrong relative path silently
// un-mocks and the bridge would scan the REAL session directory (铁律).
vi.mock('../piSettings', () => ({ defaultPiAgentDir: () => agentDir }))

const { initMemoryBridge, memoryBridgeEnv } = await import('../memoryBridge')
const { sessionDirFor } = await import('../sessionHistory')

const PROJECT_A = 'D:\\工作\\组内协作开发'
const PROJECT_B = 'D:\\Documents\\投手工作区'

function writeSession(cwd: string, uuid: string, title: string, body: string): void {
  const dir = sessionDirFor(cwd, agentDir)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', id: uuid, title }),
    JSON.stringify({ type: 'title', title }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: body } })
  ]
  writeFileSync(path.join(dir, `2026-11-20T10-00-00-000Z_${uuid}.jsonl`), lines.join('\n') + '\n', 'utf-8')
}

async function call(session: { id: string; cwd: string; title?: string }, payload: Record<string, unknown>): Promise<any> {
  const env = memoryBridgeEnv(session.id)
  const url = env.TOUSHOU_MEMORY
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return response.json()
}

beforeEach(() => {
  rmSync(path.join(agentDir, 'sessions'), { recursive: true, force: true })
})

describe('memory bridge (project isolation enforced server-side)', () => {
  it('searches ONLY the current project sessions, even when both projects contain the keyword', async () => {
    writeSession(PROJECT_A, 'aaaaaaaa-1111-4000-8000-00000000000a', '产品视频脚本', '客户预算是每天五百美元')
    writeSession(PROJECT_B, 'bbbbbbbb-2222-4000-8000-00000000000b', '地图引导视频', '客户预算是每天三百美元')
    await initMemoryBridge((sessionId) =>
      sessionId === 's-a' ? { id: 's-a', cwd: PROJECT_A, title: '产品视频脚本' } : { id: 's-b', cwd: PROJECT_B, title: '地图引导视频' }
    )

    const fromA = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'session_search', keywords: ['预算'] })
    expect(fromA.ok).toBe(true)
    expect(fromA.hits).toHaveLength(1)
    expect(fromA.hits[0].uuid).toBe('aaaaaaaa-1111-4000-8000-00000000000a')
    expect(fromA.hits[0].title).toBe('产品视频脚本')

    const fromB = await call({ id: 's-b', cwd: PROJECT_B }, { action: 'session_search', keywords: ['预算'] })
    expect(fromB.ok).toBe(true)
    expect(fromB.hits.map((h: any) => h.uuid)).toEqual(['bbbbbbbb-2222-4000-8000-00000000000b'])
  })

  it('narrows by titleWords and days, returns bounded snippets, and misses cleanly', async () => {
    writeSession(PROJECT_A, 'cccccccc-3333-4000-8000-00000000000c', '投放日报', '英语素材的点击率提升了三倍')
    await initMemoryBridge((sessionId) => (sessionId === 's-a' ? { id: 's-a', cwd: PROJECT_A, title: '投放日报' } : undefined))

    const byTitle = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'session_search', keywords: ['点击率'], titleWords: '投放' })
    expect(byTitle.hits).toHaveLength(1)
    const byWrongTitle = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'session_search', keywords: ['点击率'], titleWords: '看板' })
    expect(byWrongTitle.hits).toHaveLength(0)
    const miss = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'session_search', keywords: ['不存在的词'] })
    expect(miss.ok).toBe(true)
    expect(miss.hits).toHaveLength(0)
  })

  it('reads a hit back by uuid with a bounded excerpt around the keyword', async () => {
    writeSession(PROJECT_A, 'dddddddd-4444-4000-8000-00000000000d', '素材需求文档', '前置上下文。重点结论：广告预算每天五百。后置上下文补充说明。')
    await initMemoryBridge((sessionId) => (sessionId === 's-a' ? { id: 's-a', cwd: PROJECT_A, title: '素材需求文档' } : undefined))

    const read = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'session_read', uuid: 'dddddddd-4444-4000-8000-00000000000d', keyword: '预算' })
    expect(read.ok).toBe(true)
    expect(read.title).toBe('素材需求文档')
    expect(read.excerpt).toContain('每天五百')

    const absent = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'session_read', uuid: 'eeeeeeee-5555-4000-8000-00000000000e' })
    expect(absent).toEqual({ ok: false, error: 'session-not-found' })
  })

  it('refuses unknown tokens and saves memory under the SESSION project, not the caller claim', async () => {
    await initMemoryBridge((sessionId) => {
      if (sessionId === 's-a') return { id: 's-a', cwd: PROJECT_A, title: 'A' }
      if (sessionId === 's-b') return { id: 's-b', cwd: PROJECT_B, title: 'B' }
      return undefined
    })
    const saved = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'memory_save', text: 'A 项目的口径：只投印尼', scope: 'project' })
    expect(saved.ok).toBe(true)
    expect(saved.scope).toBe('project')

    // 另一个项目在它的会话里看不到这条（隔离由 Main 裁决）。
    const fromB = await call({ id: 's-b', cwd: PROJECT_B }, { action: 'memory_list' })
    expect(fromB.ok).toBe(true)
    expect(fromB.project).toEqual([])
    expect(fromB.global).toEqual([])
  })
})
