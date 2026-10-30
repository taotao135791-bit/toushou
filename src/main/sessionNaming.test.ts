import { describe, expect, it, vi } from 'vitest'
import { announceNamedTask, createSessionNamer, type SessionNamingDeps } from './sessionNaming'

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
    await expect(second).resolves.toEqual({ title: 'Daily report 2' })
    release!()
    await expect(first).resolves.toEqual({ title: 'Daily report' })
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
    expect(await Promise.all([first, second])).toEqual([{ title: 'First' }, { title: 'Second' }])
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
    await expect(name('b', 'Report')).resolves.toEqual({ title: 'Report' })
    expect(f.getTitles()).toEqual({ '/synthetic/b': 'Report' })
  })

  it('preserves the same title on the current session, and ignores its old resumed file', async () => {
    const f = fixture()
    f.sessions[0].title = 'Report'
    f.deps.getSession = (id) => id === 'a' ? { ...f.sessions[0], resumeFrom: '/synthetic/original' } : f.sessions[1]
    f.deps.getTitles = () => ({ '/synthetic/original': 'Report', '/synthetic/a': 'Report' })
    const name = createSessionNamer(f.deps)
    await expect(name('a', 'Report')).resolves.toEqual({ title: 'Report' })
  })

  it('persists only the latest successful early name when the file arrives', async () => {
    const f = fixture()
    delete f.sessions[0].sessionFile
    const name = createSessionNamer(f.deps)
    await expect(name('a', 'First')).resolves.toEqual({ title: 'First' })
    await expect(name('a', 'Second')).resolves.toEqual({ title: 'Second' })
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
    await expect(name('a', 'Accepted')).resolves.toEqual({ title: 'Accepted' })
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
    await expect(operation).resolves.toEqual({ title: 'Accepted' })
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
