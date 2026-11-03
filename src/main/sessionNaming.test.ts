import { describe, expect, it, vi } from 'vitest'
import { announceNamedTask, createSessionNamer, indexSessionTitleOverlays, normalizeSessionTitleFile, removeSessionTitleOverlays, type SessionNamingDeps } from './sessionNaming'
import { dispatchSessionTopic } from './sessionTopicBridge'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function fixture() {
  const sessions: Array<{ id: string; title: string; sessionFile?: string; resumeFrom?: string }> = [
    { id: 'a', title: 'New A', sessionFile: '/synthetic/a' },
    { id: 'b', title: 'New B', sessionFile: '/synthetic/b' }
  ]
  let titles: Record<string, string> = {}
  const setRuntimeName = vi.fn(async (_id: string, _title: string) => true)
  const deps: SessionNamingDeps = {
    getSession: (id) => sessions.find((session) => session.id === id),
    listSessions: () => sessions,
    getTitles: () => titles,
    setRuntimeName,
    markTitle: (id, title) => {
      const session = sessions.find((item) => item.id === id)
      if (!session) return null
      session.title = title
      return session.sessionFile ?? session.resumeFrom ?? null
    },
    saveTitles: (value) => { titles = value }
  }
  return { deps, sessions, setRuntimeName, getTitles: () => titles }
}

describe('concurrent session title allocation', () => {
  it('reserves conflicting names without making other sessions wait', async () => {
    const f = fixture()
    let release: (() => void) | undefined
    f.setRuntimeName.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true) }))
    const name = createSessionNamer(f.deps)
    const first = name('a', 'Daily report')
    const second = name('b', 'Daily report')
    await Promise.resolve()
    expect(f.setRuntimeName).toHaveBeenCalledTimes(2)
    await expect(second).resolves.toMatchObject({ title: 'Daily report 2' })
    release!()
    await expect(first).resolves.toMatchObject({ title: 'Daily report' })
    expect(f.setRuntimeName.mock.calls).toEqual([['a', 'Daily report'], ['b', 'Daily report 2']])
    expect(f.getTitles()).toEqual({ '/synthetic/a': 'Daily report', '/synthetic/b': 'Daily report 2' })
  })

  it('keeps renames of one session in order when an earlier RPC is slow', async () => {
    const f = fixture()
    let release: (() => void) | undefined
    f.setRuntimeName.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true) }))
    const name = createSessionNamer(f.deps)
    const first = name('a', 'First')
    const second = name('a', 'Second')
    await Promise.resolve()
    expect(f.setRuntimeName.mock.calls).toEqual([['a', 'First']])
    release!()
    expect((await Promise.all([first, second])).map((item) => item?.title)).toEqual(['First', 'Second'])
    expect(f.getTitles()['/synthetic/a']).toBe('Second')
  })

  it('does not reserve a failed name or block later operations on rejection', async () => {
    const f = fixture()
    f.setRuntimeName.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('synthetic failure'))
    const name = createSessionNamer(f.deps)
    const first = name('a', 'Report')
    const second = name('a', 'Report')
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    await expect(name('b', 'Report')).resolves.toMatchObject({ title: 'Report' })
    expect(f.getTitles()).toEqual({ '/synthetic/b': 'Report' })
  })

  it('preserves the same title on the current session, and ignores its old resumed file', async () => {
    const f = fixture()
    f.sessions[0].title = 'Report'
    f.sessions[0].resumeFrom = '/synthetic/original'
    f.deps.getTitles = () => ({ '/synthetic/original': 'Report', '/synthetic/a': 'Report' })
    const name = createSessionNamer(f.deps)
    await expect(name('a', 'Report')).resolves.toMatchObject({ title: 'Report' })
  })

  it('persists only the latest successful early name when the file arrives', async () => {
    const f = fixture()
    delete f.sessions[0].sessionFile
    const name = createSessionNamer(f.deps)
    await expect(name('a', 'First')).resolves.toMatchObject({ title: 'First' })
    await expect(name('a', 'Second')).resolves.toMatchObject({ title: 'Second' })
    expect(f.getTitles()).toEqual({})
    f.sessions[0].sessionFile = '/synthetic/a'
    name.fileAvailable('a', '/synthetic/a')
    expect(f.getTitles()).toEqual({ '/synthetic/a': 'Second' })
    name.fileAvailable('a', '/synthetic/a')
    expect(f.getTitles()).toEqual({ '/synthetic/a': 'Second' })
  })

  it('does not persist default names, failed renames, or closed sessions', async () => {
    const f = fixture()
    delete f.sessions[0].sessionFile
    const name = createSessionNamer(f.deps)
    name.fileAvailable('a', '/synthetic/a')
    expect(f.getTitles()).toEqual({})
    f.setRuntimeName.mockResolvedValueOnce(false)
    await expect(name('a', 'Failed')).resolves.toBeNull()
    f.sessions[0].sessionFile = '/synthetic/a'
    name.fileAvailable('a', '/synthetic/a')
    expect(f.getTitles()).toEqual({})
    delete f.sessions[0].sessionFile
    await expect(name('a', 'Accepted')).resolves.toMatchObject({ title: 'Accepted' })
    f.sessions.splice(0, 1)
    name.fileAvailable('a', '/synthetic/a')
    expect(f.getTitles()).toEqual({})
  })

  it('persists to the new file if it arrives while the rename RPC is pending', async () => {
    const f = fixture()
    delete f.sessions[0].sessionFile
    let release!: () => void
    f.setRuntimeName.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true) }))
    const name = createSessionNamer(f.deps)
    const operation = name('a', 'Accepted')
    await Promise.resolve()
    f.sessions[0].sessionFile = '/synthetic/a'
    name.fileAvailable('a', '/synthetic/a')
    release()
    await expect(operation).resolves.toMatchObject({ title: 'Accepted' })
    expect(f.getTitles()).toEqual({ '/synthetic/a': 'Accepted' })
  })

  it('retries writing an early name when the store temporarily fails', async () => {
    const f = fixture()
    delete f.sessions[0].sessionFile
    const name = createSessionNamer(f.deps)
    await name('a', 'Accepted')
    f.sessions[0].sessionFile = '/synthetic/a'
    const save = f.deps.saveTitles
    f.deps.saveTitles = vi.fn().mockImplementationOnce(() => { throw new Error('synthetic') }).mockImplementation(save)
    name.fileAvailable('a', '/synthetic/a')
    expect(f.getTitles()).toEqual({})
    name.fileAvailable('a', '/synthetic/a')
    expect(f.getTitles()).toEqual({ '/synthetic/a': 'Accepted' })
  })

  it('copies a resumed session title to its newly discovered fork', async () => {
    const f = fixture()
    delete f.sessions[0].sessionFile
    f.sessions[0].resumeFrom = '/synthetic/original'
    const name = createSessionNamer(f.deps)
    await name('a', 'Accepted')
    expect(f.getTitles()).toEqual({ '/synthetic/original': 'Accepted' })
    f.sessions[0].sessionFile = '/synthetic/fork'
    name.fileAvailable('a', '/synthetic/fork')
    expect(f.getTitles()).toEqual({ '/synthetic/original': 'Accepted', '/synthetic/fork': 'Accepted' })
  })

  it('fails closed for an unknown session or blank name', async () => {
    const f = fixture()
    const name = createSessionNamer(f.deps)
    await expect(name('missing', 'Report')).resolves.toBeNull()
    await expect(name('a', '  ')).resolves.toBeNull()
    expect(f.setRuntimeName).not.toHaveBeenCalled()
  })
})


describe('task announcement', () => {
  it('uses the canonical name after naming settles and does not recreate closed sessions', async () => {
    let resolve!: (result: { title: string } | null) => void
    const naming = new Promise<{ title: string } | null>((r) => { resolve = r })
    const announce = vi.fn()
    const task = announceNamedTask(naming, () => true, 'Daily', announce)
    expect(announce).not.toHaveBeenCalled()
    resolve({ title: 'Daily 2' })
    await task
    expect(announce.mock.calls).toEqual([['Daily 2']])
    const closed = vi.fn()
    await announceNamedTask(Promise.resolve({ title: 'Daily 3' }), () => false, 'Daily', closed)
    expect(closed).not.toHaveBeenCalled()
    await announceNamedTask(Promise.resolve(null), () => true, 'Daily', closed)
    expect(closed.mock.calls).toEqual([['Daily']])
  })
})

describe('automatic conversation topics', () => {
  function topicFixture() {
    const f = fixture()
    let metadata: Record<string, { source: 'auto' | 'manual'; revision: number }> = {}
    f.deps.getMetadata = () => metadata
    f.deps.saveMetadata = (value) => { metadata = value }
    f.deps.onTitleChanged = vi.fn()
    return { ...f, getMetadata: () => metadata }
  }

  it('accepts first fallback immediately, without a mid-turn runtime RPC or paid model call', async () => {
    const f = topicFixture()
    const name = createSessionNamer(f.deps)
    name.advance('a')
    const result = name('a', 'TikTok投放分析', { source: 'auto' })
    expect(f.sessions[0].title).toBe('TikTok投放分析')
    expect(f.setRuntimeName).not.toHaveBeenCalled()
    await expect(result).resolves.toEqual({ title: 'TikTok投放分析', source: 'auto', revision: 1 })
    expect(f.getMetadata()['/synthetic/a']).toEqual({ source: 'auto', revision: 1 })
    name.runtimeIdle('a')
    await Promise.resolve()
    expect(f.setRuntimeName).toHaveBeenCalledWith('a', 'TikTok投放分析')
  })

  it('updates the semantic topic as later turns evolve, rejecting stale revisions and late fallbacks', async () => {
    const f = topicFixture()
    const name = createSessionNamer(f.deps)
    const first = name.advance('a')
    await name('a', '账户分析', { source: 'auto' })
    await name('a', 'TikTok转化成本诊断', { source: 'auto', revision: first })
    await expect(name('a', '账户分析', { source: 'auto' })).resolves.toBeNull()
    await expect(name('a', '同轮晚到的旧主题', { source: 'auto', revision: first })).resolves.toBeNull()
    const next = name.advance('a')
    await name('a', '转化成本趋势看板', { source: 'auto', revision: next })
    await expect(name('a', '旧目标', { source: 'auto', revision: first })).resolves.toBeNull()
    expect(f.sessions[0].title).toBe('转化成本趋势看板')
  })

  it('locks manual names before their slow RPC resolves and preserves the lock on restart', async () => {
    const f = topicFixture()
    const name = createSessionNamer(f.deps)
    name.advance('a')
    await name('a', '自动主题', { source: 'auto' })
    let finish!: () => void
    f.setRuntimeName.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true) }))
    const manual = name('a', '我的周报')
    await Promise.resolve()
    await expect(name('a', '模型晚到的主题', { source: 'auto', revision: name.revision('a') })).resolves.toBeNull()
    finish()
    await manual
    const restored = createSessionNamer(f.deps)
    restored.advance('a')
    await expect(restored('a', '重新生成', { source: 'auto', revision: restored.revision('a') })).resolves.toBeNull()
    expect(f.sessions[0].title).toBe('我的周报')
    expect(f.getMetadata()['/synthetic/a'].source).toBe('manual')
  })

  it('restores a manual title and lock when two path aliases disagree after restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-alias-'))
    try {
      const directory = path.join(root, 'real'); const alias = path.join(root, 'alias')
      fs.mkdirSync(directory)
      fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const canonical = path.join(fs.realpathSync.native(directory), 'session.jsonl')
      const throughAlias = path.join(alias, 'session.jsonl')
      const unrelated = path.join(directory, 'unrelated.jsonl')
      fs.writeFileSync(canonical, '{}'); fs.writeFileSync(unrelated, '{}')
      let titles = { [throughAlias]: '人工保留主题', [canonical]: '自动覆盖主题', [unrelated]: '其他对话' }
      let metadata: Record<string, {source:'auto'|'manual';revision:number}> = {
        [throughAlias]: {source:'manual',revision:2}, [canonical]: {source:'auto',revision:9}, [unrelated]:{source:'auto',revision:1}
      }
      const overlay = indexSessionTitleOverlays(titles, metadata, normalizeSessionTitleFile).get(normalizeSessionTitleFile(canonical))!
      expect(overlay).toEqual({title:'人工保留主题', metadata:{source:'manual',revision:2}})
      const f = fixture()
      f.sessions[0] = { id:'a', title:overlay.title!, resumeFrom:canonical }
      f.deps.getTitles = () => titles
      f.deps.saveTitles = value => { titles = value }
      f.deps.getMetadata = () => metadata
      f.deps.saveMetadata = value => { metadata = value }
      f.deps.normalizeFile = normalizeSessionTitleFile
      f.deps.markMetadata = (id, value) => { if (id === 'a') Object.assign(f.sessions[0], {titleSource:value.source, titleRevision:value.revision}) }
      const restored = createSessionNamer(f.deps)
      const revision = restored.advance('a')
      const bridgeDeps = { getSession:f.deps.getSession, getRevision:restored.revision, nameSession:restored }
      expect(await dispatchSessionTopic(bridgeDeps, 'a', {action:'context'})).toMatchObject({ok:true,manual:true})
      expect(await dispatchSessionTopic(bridgeDeps, 'a', {action:'topic', title:'晚到的自动主题', revision})).toMatchObject({ok:false})
      expect(f.sessions[0].title).toBe('人工保留主题')
      expect(await restored('a', '人工保留主题')).toMatchObject({title:'人工保留主题',source:'manual'})
      expect(titles[canonical]).toBe('人工保留主题')
      expect(titles[throughAlias]).toBe('人工保留主题')
      expect(metadata[canonical].source).toBe('manual')
      expect(metadata[throughAlias].source).toBe('manual')
      expect(titles[unrelated]).toBe('其他对话')
      fs.unlinkSync(canonical)
      const cleanedTitles = removeSessionTitleOverlays(titles, canonical)
      const cleanedMetadata = removeSessionTitleOverlays(metadata, canonical)
      expect(Object.keys(cleanedTitles)).toEqual([unrelated])
      expect(Object.keys(cleanedMetadata)).toEqual([unrelated])
    } finally { fs.rmSync(root, {recursive:true, force:true}) }
  })

  it('restores an automatic topic and revision across early naming, file discovery, fork and restart', async () => {
    const f = topicFixture()
    delete f.sessions[0].sessionFile
    f.sessions[0].resumeFrom = '/synthetic/original'
    const name = createSessionNamer(f.deps)
    const revision = name.advance('a')
    await name('a', '预算分析', { source: 'auto', revision })
    f.sessions[0].sessionFile = '/synthetic/fork'
    name.fileAvailable('a', '/synthetic/fork')
    expect(f.getMetadata()).toEqual({
      '/synthetic/original': { source: 'auto', revision: 1 },
      '/synthetic/fork': { source: 'auto', revision: 1 }
    })
    const restored = createSessionNamer(f.deps)
    const next = restored.advance('a')
    expect(next).toBe(2)
    await expect(restored('a', '预算优化方案', { source: 'auto', revision: next })).resolves.toMatchObject({ title: '预算优化方案' })
  })

  it('treats legacy custom names as manual, while accepting an unnamed new conversation', async () => {
    const f = topicFixture()
    f.deps.getTitles = () => ({ '/synthetic/a': '已命名周报' })
    const name = createSessionNamer(f.deps)
    await expect(name('a', '覆盖旧名', { source: 'auto' })).resolves.toBeNull()
    await expect(name('b', '新的主题', { source: 'auto' })).resolves.toMatchObject({ title: '新的主题' })
  })

  it('redacts synthetic credentials and advertiser IDs at the Main boundary', async () => {
    const f = topicFixture()
    const name = createSessionNamer(f.deps)
    await name('a', 'TikTok 7123456789012345678 sk-syntheticCredentialValue123 分析', { source: 'auto' })
    expect(f.sessions[0].title).toBe('TikTok 分析')
    expect(JSON.stringify(f.getTitles())).not.toMatch(/7123456789|syntheticCredential/)
  })

  it('does not let a late runtime sync overwrite a newer automatic or manual title', async () => {
    const f = topicFixture()
    const name = createSessionNamer(f.deps)
    name.advance('a')
    await name('a', '最初主题', { source: 'auto' })
    let finish!: () => void
    f.setRuntimeName.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true) }))
    name.runtimeIdle('a')
    await name('a', '更新后的主题', { source: 'auto', revision: name.revision('a') })
    finish()
    await new Promise((resolve) => setImmediate(resolve))
    expect(f.sessions[0].title).toBe('更新后的主题')
    name.runtimeIdle('a')
    await Promise.resolve()
    expect(f.setRuntimeName).toHaveBeenLastCalledWith('a', '更新后的主题')
  })

  it('cannot apply a stale result to a replacement session with the same id', async () => {
    const f = topicFixture()
    const name = createSessionNamer(f.deps)
    let finish!: () => void
    f.setRuntimeName.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true) }))
    const pending = name('a', '旧实例')
    await Promise.resolve()
    f.sessions[0] = { id: 'a', title: 'New A', sessionFile: '/synthetic/new' }
    finish()
    await expect(pending).resolves.toBeNull()
    expect(f.sessions[0].title).toBe('New A')
    expect(f.getTitles()).toEqual({})
  })
})
