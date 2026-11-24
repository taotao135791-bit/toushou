import { expect, it, vi } from 'vitest'
import type { SessionState } from '../../shared/types'
import { BoardBuildThinking } from './boardBuildThinking'

function fixture() {
  const read = vi.fn<() => Promise<Pick<SessionState, 'thinkingLevel' | 'modelThinking'> | null>>().mockResolvedValue({ thinkingLevel: 'high' })
  const write = vi.fn<(_id: string, _level: string) => Promise<boolean>>().mockResolvedValue(true)
  const isActive = vi.fn().mockReturnValue(true)
  return { read, write, isActive, controller: new BoardBuildThinking({ read, write, isActive }) }
}

it('uses a single temporary setting and restores it before the next prompt', async () => {
  const { controller, read, write } = fixture()
  await controller.start('session', 'draft')
  await controller.start('session', 'draft')
  controller.finish('session', 'stale-draft')
  expect(read).toHaveBeenCalledTimes(1)
  expect(write.mock.calls).toEqual([['session', 'medium']])
  controller.finish('session', 'draft')
  expect(write.mock.calls).toEqual([['session', 'medium'], ['session', 'high']])
})

it('discards a state response that arrives after cancellation or a newer draft', async () => {
  const { controller, read, write } = fixture()
  const pending = Promise.withResolvers<{ thinkingLevel: string }>()
  read.mockReturnValueOnce(pending.promise)
  const start = controller.start('session', 'old-draft')
  controller.finish('session', 'old-draft')
  await controller.start('session', 'new-draft')
  pending.resolve({ thinkingLevel: 'max' })
  await start
  controller.finish('session', 'new-draft')
  expect(write.mock.calls).toEqual([['session', 'medium'], ['session', 'high']])
})

it('does not reset a newer user selection or lower the same stopped draft again', async () => {
  const { controller, write } = fixture()
  const ack = Promise.withResolvers<boolean>()
  write.mockReturnValueOnce(ack.promise)
  const start = controller.start('session', 'draft')
  await Promise.resolve()
  controller.stopForDraft('session', 'draft')
  await write('session', 'low')
  ack.resolve(true)
  await start
  await controller.start('session', 'draft')
  controller.finish('session', 'draft')
  expect(write.mock.calls).toEqual([['session', 'medium'], ['session', 'high'], ['session', 'low']])
})

it('preserves a model that has no supported medium level and discards work on close', async () => {
  const { controller, read, write } = fixture()
  read.mockResolvedValueOnce({ thinkingLevel: 'high', modelThinking: { reasoning: true, thinking: ['low', 'high'] } })
  await controller.start('session', 'draft')
  controller.finish('session', 'draft')
  const pending = Promise.withResolvers<{ thinkingLevel: string }>()
  read.mockReturnValueOnce(pending.promise)
  const start = controller.start('session', 'closed-draft')
  controller.close('session')
  pending.resolve({ thinkingLevel: 'max' })
  await start
  expect(write).not.toHaveBeenCalled()
})
