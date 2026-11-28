import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter, once } from 'node:events'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { PermissionMode, SessionEvent } from '../../shared/types'

const agentDir = mkdtempSync(path.join(tmpdir(), 'memory-bridge-agent-'))
const stableUserData = mkdtempSync(path.join(tmpdir(), 'memory-bridge-user-'))
// 跨项目确认框：测试里用这个开关模拟用户「允许/拒绝」。
const confirmState = vi.hoisted(() => ({ allowed: true }))
// 广播事件捕获（memory_save 的"已记住"通知），断言用。
const sentEvents = vi.hoisted(() => [] as unknown[])
vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [{
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { isDestroyed: () => false, send: (_channel: string, payload: unknown) => { sentEvents.push(payload) } }
    }]
  },
  app: { getPath: () => stableUserData },
  dialog: {
    showMessageBox: async () => ({ response: confirmState.allowed ? 0 : 1 })
  }
}))
// NOTE: path relative to THIS test file — a wrong relative path silently
// un-mocks and the bridge would scan the REAL session directory (铁律).
vi.mock('../piSettings', () => ({ defaultPiAgentDir: () => agentDir }))

const { cancelPendingMemoryMutations, initMemoryBridge, memoryBridgeEnv, respondMemoryMutation, setMemoryTurnOwner } = await import('../memoryBridge')
const { sessionDirFor } = await import('../sessionHistory')
const { saveMemoryEntry, updateMemoryText } = await import('../memoryStore')
const { setStore } = await import('../store')

const PROJECT_A = 'D:\\工作\\组内协作开发'
const PROJECT_B = 'D:\\Documents\\投手工作区'

function writeSession(cwd: string, uuid: string, title: string, body: string): void {
  const dir = sessionDirFor(cwd, agentDir)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', id: uuid, title, cwd }),
    JSON.stringify({ type: 'title', title }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: body } })
  ]
  writeFileSync(path.join(dir, `2026-11-20T10-00-00-000Z_${uuid}.jsonl`), lines.join('\n') + '\n', 'utf-8')
}

async function call(session: { id: string; cwd: string; title?: string }, payload: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const env = memoryBridgeEnv(session.id)
  const url = env.TOUSHOU_MEMORY
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  })
  return response.json()
}

beforeEach(() => {
  confirmState.allowed = true
  setStore('memoryEnabled', true)
  cancelPendingMemoryMutations()
  rmSync(path.join(stableUserData, 'memory'), { recursive: true, force: true })
  rmSync(path.join(agentDir, 'sessions'), { recursive: true, force: true })
})

class MemoryWindow extends EventEmitter {
  isDestroyed = () => false
  send = (_channel: string, event: SessionEvent) => { this.emit(event.type, event) }
  asOwner = () => this as unknown as WebContents
}

async function memoryFixture() {
  const session = { id: 'memory-mutation-review', cwd: mkdtempSync(path.join(tmpdir(), 'memory-project-')), title: 'Synthetic session' }
  let mode: PermissionMode = 'full'
  await initMemoryBridge(id => id === session.id ? { ...session, mode, instruction: 'Synthetic conversation instruction' } : undefined)
  const window = new MemoryWindow()
  const owner = window.asOwner()
  setMemoryTurnOwner(session.id, owner)
  const save = (text: string) => {
    const result = saveMemoryEntry({ text, scope: 'project', cwd: session.cwd })
    if (!result.ok) throw new Error(result.error)
    return result.entry.id
  }
  const begin = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    const shown = once(window, 'ui_request')
    const result = call(session, body, signal).then(value => ({ value }), error => ({ error }))
    const [event] = await shown
    return { event: event as Extract<SessionEvent, { type: 'ui_request' }>, result }
  }
  return { session, window, owner, save, begin, mode: (value: PermissionMode) => { mode = value } }
}

describe('Agent memory controls', () => {
  it('bounds search results and returns only the selected scope with a continuation', async () => {
    const { session, save } = await memoryFixture()
    save('needle A ' + '字'.repeat(350))
    save('needle B ' + '字'.repeat(350))
    save('unrelated entry')
    const first = await call(session, { action: 'memory_list', scope: 'project', query: 'NEEDLE', limit: 1 })
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]).toMatchObject({ scope: 'project', truncated: true })
    expect(first.entries[0].text).toHaveLength(300)
    const second = await call(session, { action: 'memory_list', scope: 'project', query: 'needle', limit: 1, cursor: first.nextCursor })
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0].id).not.toBe(first.entries[0].id)
    expect(second.nextCursor).toBeNull()
    expect(await call(session, { action: 'memory_list', limit: 21 })).toMatchObject({ ok: false })
  })

  it('shows complete before and after text to its originating window and rereads edits/deletes next turn', async () => {
    const { session, owner, save, begin } = await memoryFixture()
    const original = '旧'.repeat(600) + ' OLD END'
    const replacement = '新'.repeat(600) + ' NEW END'
    const id = save(original)
    const { event, result } = await begin({ action: 'memory_update', scope: 'project', id, text: replacement })
    expect(event.message).toContain(original)
    expect(event.message).toContain(replacement)
    expect(event.message).toContain(path.basename(session.cwd))
    expect(respondMemoryMutation(session.id, event.id, { confirmed: true }, new MemoryWindow().asOwner())).toBe(false)
    expect(respondMemoryMutation(session.id, event.id, { confirmed: true, text: 'tampered' }, owner)).toBe(false)
    expect(respondMemoryMutation(session.id, event.id, { confirmed: true }, owner)).toBe(true)
    expect(respondMemoryMutation(session.id, event.id, { confirmed: true }, owner)).toBe(false)
    expect(await result).toMatchObject({ value: { ok: true, id } })
    const after = await call(session, { action: 'prompt_context' })
    expect(after.prompt).toContain(replacement)
    expect(after.prompt).not.toContain(original)

    const removal = await begin({ action: 'memory_delete', scope: 'project', id })
    expect(removal.event.message).toContain(replacement)
    expect(respondMemoryMutation(session.id, removal.event.id, { confirmed: true }, owner)).toBe(true)
    expect(await removal.result).toMatchObject({ value: { ok: true, id } })
    expect((await call(session, { action: 'prompt_context' })).prompt).not.toContain(replacement)
  })

  it('blocks reads and writes when disabled, cancels pending approvals and preserves stored entries on re-enable', async () => {
    const { session, owner, save, begin } = await memoryFixture()
    const text = 'Synthetic long-term memory'
    const id = save(text)
    const pending = await begin({ action: 'memory_delete', scope: 'project', id })
    setStore('memoryEnabled', false)
    cancelPendingMemoryMutations()
    expect(respondMemoryMutation(session.id, pending.event.id, { confirmed: true }, owner)).toBe(false)
    expect(await pending.result).toMatchObject({ value: { ok: false, error: 'memory-disabled' } })
    for (const action of ['memory_list', 'memory_all_projects', 'memory_search_projects', 'memory_save', 'memory_update', 'memory_delete']) {
      expect(await call(session, { action, scope: 'project', id, text: 'Discard this' })).toEqual({ ok: false, error: 'memory-disabled' })
    }
    const disabled = await call(session, { action: 'prompt_context' })
    expect(disabled.prompt).toContain('Synthetic conversation instruction')
    expect(disabled.prompt).not.toContain(text)
    expect(disabled.prompt).not.toContain('toushou_memory_')
    setStore('memoryEnabled', true)
    const enabled = await call(session, { action: 'prompt_context' })
    expect(enabled.prompt).toContain(text)
    expect(enabled.prompt).toContain('toushou_memory_update')
  })

  it('rejects read-only writes and rechecks permission and the entry before committing', async () => {
    const { session, mode, owner, save, begin } = await memoryFixture()
    const id = save('Before approval')
    const write = { action: 'memory_update', scope: 'project', id, text: 'Agent change' }
    mode('readonly')
    expect(await call(session, write)).toMatchObject({ ok: false, error: 'permission-denied' })
    mode('full')
    const narrowed = await begin(write)
    mode('readonly')
    expect(respondMemoryMutation(session.id, narrowed.event.id, { confirmed: true }, owner)).toBe(true)
    expect(await narrowed.result).toMatchObject({ value: { ok: false, error: 'permission-denied' } })

    mode('full')
    const pending = await begin(write)
    expect(updateMemoryText('project', id, 'User edit in settings', session.cwd)).toBe(true)
    expect(respondMemoryMutation(session.id, pending.event.id, { confirmed: true }, owner)).toBe(true)
    expect(await pending.result).toMatchObject({ value: { ok: false, error: 'stale-entry' } })
    expect((await call(session, { action: 'prompt_context' })).prompt).toContain('User edit in settings')
  })

  it('cancels on client disconnect and when the turn ends', async () => {
    const { session, window, owner, save, begin } = await memoryFixture()
    const id = save('Original synthetic memory')
    const remove = { action: 'memory_delete', scope: 'project', id }
    const controller = new AbortController()
    const first = await begin(remove, controller.signal)
    const closed = once(window, 'ui_cancel')
    controller.abort()
    await closed
    expect(await first.result).toMatchObject({ error: { name: 'AbortError' } })
    expect(respondMemoryMutation(session.id, first.event.id, { confirmed: true }, owner)).toBe(false)
    const second = await begin(remove)
    setMemoryTurnOwner(session.id)
    expect(await second.result).toMatchObject({ value: { ok: false, error: 'cancelled' } })
    expect(respondMemoryMutation(session.id, second.event.id, { confirmed: true }, owner)).toBe(false)
    expect((await call(session, { action: 'prompt_context' })).prompt).toContain('Original synthetic memory')
  })
})

describe('memory bridge (project isolation enforced server-side)', () => {
  it('searches ONLY the current project sessions, even when both projects contain the keyword', async () => {
    writeSession(PROJECT_A, 'aaaaaaaa-1111-4000-8000-00000000000a', '产品视频脚本', '客户预算是每天五百美元')
    writeSession(PROJECT_B, 'bbbbbbbb-2222-4000-8000-00000000000b', '地图引导视频', '客户预算是每天三百美元')
    await initMemoryBridge((sessionId) =>
      sessionId === 's-a' ? { id: 's-a', mode: 'full', cwd: PROJECT_A, title: '产品视频脚本' } : { id: 's-b', mode: 'full', cwd: PROJECT_B, title: '地图引导视频' }
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
    await initMemoryBridge((sessionId) => (sessionId === 's-a' ? { id: 's-a', mode: 'full', cwd: PROJECT_A, title: '投放日报' } : undefined))

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
    await initMemoryBridge((sessionId) => (sessionId === 's-a' ? { id: 's-a', mode: 'full', cwd: PROJECT_A, title: '素材需求文档' } : undefined))

    const read = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'session_read', uuid: 'dddddddd-4444-4000-8000-00000000000d', keyword: '预算' })
    expect(read.ok).toBe(true)
    expect(read.title).toBe('素材需求文档')
    expect(read.excerpt).toContain('每天五百')

    const absent = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'session_read', uuid: 'eeeeeeee-5555-4000-8000-00000000000e' })
    expect(absent).toEqual({ ok: false, error: 'session-not-found' })
  })

  it('refuses unknown tokens and saves memory under the SESSION project, not the caller claim', async () => {
    await initMemoryBridge((sessionId) => {
      if (sessionId === 's-a') return { id: 's-a', mode: 'full', cwd: PROJECT_A, title: 'A' }
      if (sessionId === 's-b') return { id: 's-b', mode: 'full', cwd: PROJECT_B, title: 'B' }
      return undefined
    })
    const saved = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'memory_save', text: 'A 项目的口径：只投印尼', scope: 'project' })
    expect(saved.ok).toBe(true)
    expect(saved.scope).toBe('project')

    // 另一个项目在它的会话里看不到这条（隔离由 Main 裁决）。
    const fromB = await call({ id: 's-b', cwd: PROJECT_B }, { action: 'memory_list' })
    expect(fromB.ok).toBe(true)
    expect(fromB.entries).toEqual([])
    const fromA = await call({ id: 's-a', cwd: PROJECT_A }, { action: 'memory_list' })
    expect(fromA.entries).toEqual([expect.objectContaining({ id: saved.id, scope: 'project', text: 'A 项目的口径：只投印尼' })])
  })

  it('enforces read-only access at the bridge and confirms writes in Ask mode', async () => {
    await initMemoryBridge(id => ({
      id, cwd: PROJECT_A,
      mode: id === 'ask' ? 'ask' : 'readonly',
      remoteReadonly: id === 'remote'
    }))
    const write = { action: 'memory_save', text: 'Synthetic permission check' }
    confirmState.allowed = false
    expect(await call({ id: 'ask', cwd: PROJECT_A }, write)).toEqual({ ok: false, error: 'permission-denied' })
    confirmState.allowed = true
    expect(await call({ id: 'readonly', cwd: PROJECT_A }, write)).toEqual({ ok: false, error: 'permission-denied' })
    expect(await call({ id: 'remote', cwd: PROJECT_A }, { action: 'prompt_context' })).toEqual({ ok: false, error: 'permission-denied' })
    expect(await call({ id: 'ask', cwd: PROJECT_A }, write)).toMatchObject({ ok: true })
  })

  it('reads the current instructions each time the runtime starts a turn', async () => {
    let instruction = 'Synthetic session instructions'
    await initMemoryBridge(id => ({ id, cwd: PROJECT_A, mode: 'full', instruction }))
    const from = { id: 'context', cwd: PROJECT_A }
    expect((await call(from, { action: 'prompt_context' })).prompt).toContain(instruction)
    instruction = ''
    expect((await call(from, { action: 'prompt_context' })).prompt).not.toContain('Synthetic session instructions')
  })

  describe('cross-project memory access (manual gate)', () => {
    beforeEach(async () => {
      writeSession(PROJECT_A, 'aaaaaaaa-1111-4000-8000-00000000000a', '产品视频脚本', '客户预算是每天五百美元')
      writeSession(PROJECT_B, 'bbbbbbbb-2222-4000-8000-00000000000b', '地图引导视频', '客户预算是每天三百美元')
      await initMemoryBridge((sessionId) => {
        if (sessionId === 's-a') return { id: 's-a', mode: 'full', cwd: PROJECT_A, title: '产品视频脚本' }
        if (sessionId === 's-b') return { id: 's-b', mode: 'full', cwd: PROJECT_B, title: '地图引导视频' }
        return undefined
      })
      confirmState.allowed = true
      await call({ id: 's-a', cwd: PROJECT_A }, { action: 'memory_save', text: 'A 项目的口径：只投印尼', scope: 'project' })
    })

    it('memory_all_projects returns other projects ONLY after the user allows the dialog', async () => {
      confirmState.allowed = false
      const declined = await call({ id: 's-b', cwd: PROJECT_B }, { action: 'memory_all_projects' })
      expect(declined.ok).toBe(true)
      expect(declined.confirmedCrossProject).toBe(false)
      expect(declined.otherProjects).toEqual([])
      // 全局和当前项目不受影响，照常返回。
      expect(declined.currentProject).toEqual([])

      confirmState.allowed = true
      const allowed = await call({ id: 's-b', cwd: PROJECT_B }, { action: 'memory_all_projects' })
      expect(allowed.confirmedCrossProject).toBe(true)
      expect(allowed.otherProjects[0].project).toBe('组内协作开发')
      expect(allowed.otherProjects[0].entries.some((e: any) => e.text.includes('只投印尼'))).toBe(true)
    })

    it('memory_search_projects matches a project by name and refuses without user consent', async () => {
      const hit = await call(
        { id: 's-b', cwd: PROJECT_B },
        { action: 'memory_search_projects', projectName: '协作开发', keywords: ['印尼'] }
      )
      expect(hit.ok).toBe(true)
      expect(hit.project).toBe('组内协作开发')
      expect(hit.entries.some((e: any) => e.text.includes('只投印尼'))).toBe(true)

      confirmState.allowed = false
      const declined = await call(
        { id: 's-b', cwd: PROJECT_B },
        { action: 'memory_search_projects', projectName: '协作开发', keywords: ['印尼'] }
      )
      expect(declined).toEqual({ ok: false, error: 'user-declined' })

      const unknown = await call(
        { id: 's-b', cwd: PROJECT_B },
        { action: 'memory_search_projects', projectName: '不存在的项目', keywords: ['x'] }
      )
      expect(unknown.ok).toBe(false)
      expect(unknown.error).toBe('project-not-found')
      expect(unknown.knownProjects).toBeUndefined()
    })

    it('session_search crosses projects ONLY with projectName AND user consent', async () => {
      // 不带 projectName：只搜当前项目（B），看不到 A 的对话。
      const scoped = await call({ id: 's-b', cwd: PROJECT_B }, { action: 'session_search', keywords: ['预算'] })
      expect(scoped.hits.map((h: any) => h.uuid)).toEqual(['bbbbbbbb-2222-4000-8000-00000000000b'])

      // 带 projectName + 用户允许：跨项目命中 A 的对话。
      const crossed = await call(
        { id: 's-b', cwd: PROJECT_B },
        { action: 'session_search', keywords: ['预算'], projectName: '协作开发' }
      )
      expect(crossed.ok).toBe(true)
      expect(crossed.scope).toContain('cross-project')
      expect(crossed.hits.some((h: any) => h.uuid === 'aaaaaaaa-1111-4000-8000-00000000000a')).toBe(true)

      // 用户拒绝确认：不返回任何内容。
      confirmState.allowed = false
      const declined = await call(
        { id: 's-b', cwd: PROJECT_B },
        { action: 'session_search', keywords: ['预算'], projectName: '协作开发' }
      )
      expect(declined).toEqual({ ok: false, error: 'user-declined' })
    })
  })

})
