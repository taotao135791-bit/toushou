import { describe, expect, it, vi } from 'vitest'
import { createSessionDeletionLocks } from '../sessionDeletionLocks'

vi.mock('../piSettings', () => ({ defaultPiAgentDir: () => '/unused' }))

describe('session deletion locks', () => {
  it('merges individual updates into the latest persisted list and only acknowledges successful changes', () => {
    let ids = ['old-session']
    const write = vi.fn((next: string[]) => { ids = next })
    const locks = createSessionDeletionLocks(() => ids, write)
    expect(locks.setLocked('../path', true)).toBe(false)
    expect(locks.setLocked('new-session', 1)).toBe(false)
    expect(locks.setLocked('new-session', true)).toBe(true)
    expect(locks.setLocked('old-session', false)).toBe(true)
    expect(ids).toEqual(['new-session'])
    write.mockImplementationOnce(() => { throw new Error('write failed') })
    expect(locks.setLocked('new-session', false)).toBe(false)
    expect(locks.isLocked('new-session')).toBe(true)
  })

  it('does not enter a locked deletion and prevents new locks until both nested operations finish', async () => {
    let ids = ['locked-session']
    const locks = createSessionDeletionLocks(() => ids, next => { ids = next })
    const operation = vi.fn(async () => true)
    await expect(locks.runDeletion(['locked-session'], operation)).resolves.toBe('locked')
    expect(operation).not.toHaveBeenCalled()

    let finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    const deleting = locks.runDeletion(['deleting-session'], async () => {
      await locks.runDeletion(['deleting-session'], operation)
      await held
      throw new Error('delete failed')
    })
    await expect(locks.runDeletion(['deleting-session'], operation)).resolves.toBe(true)
    expect(locks.setLocked('deleting-session', true)).toBe(false)
    expect(locks.setLocked('other-session', true)).toBe(true)
    finish()
    await expect(deleting).rejects.toThrow('delete failed')
    expect(locks.setLocked('deleting-session', true)).toBe(true)
  })
})
