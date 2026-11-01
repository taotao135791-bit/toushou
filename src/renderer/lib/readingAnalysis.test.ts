import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ create: vi.fn(), enqueue: vi.fn(), select: vi.fn(), drain: vi.fn() }))
vi.mock('./session', () => ({ createSessionForCurrentProject: calls.create }))
vi.mock('../store', () => ({ useAppStore: { getState: () => ({ enqueueQueuedMessage: calls.enqueue, setCurrentSessionId: calls.select, drainQueuedMessage: calls.drain }) } }))
import { startReadingAnalysis } from './readingAnalysis'

beforeEach(() => { vi.clearAllMocks(); calls.create.mockResolvedValue('analysis-session'); calls.drain.mockReturnValue(true) })
describe('explicit reading analysis', () => {
  it('sends the selected data in a separate read-only session without composer mutations', async () => {
    const prompt = 'Analyze Synthetic A (12345) spend 12 USD'
    expect(await startReadingAnalysis(prompt)).toBe('analysis-session')
    expect(calls.create).toHaveBeenCalledWith({ permissionMode: 'readonly' })
    expect(calls.enqueue).toHaveBeenCalledWith('analysis-session', { id: expect.any(String), text: prompt })
    expect(calls.select).toHaveBeenCalledWith('analysis-session')
    expect(calls.drain).toHaveBeenCalledWith('analysis-session')
  })
  it('does not queue or select anything when no session can be created', async () => {
    calls.create.mockResolvedValue(null)
    expect(await startReadingAnalysis('Analyze current readings')).toBeNull()
    expect(calls.enqueue).not.toHaveBeenCalled(); expect(calls.select).not.toHaveBeenCalled()
    expect(await startReadingAnalysis(' ')).toBeNull()
    expect(calls.create).toHaveBeenCalledTimes(1)
  })
})
