import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ create: vi.fn(), enqueue: vi.fn(), select: vi.fn(), drain: vi.fn(), launch: vi.fn(), prefill: vi.fn(), autosend: vi.fn() }))
vi.mock('./session', () => ({ createSessionForCurrentProject: calls.create }))
vi.mock('../store', () => ({ useAppStore: { getState: () => ({ enqueueQueuedMessage: calls.enqueue, setCurrentSessionId: calls.select, drainQueuedMessage: calls.drain, setBoardReadingLaunch: calls.launch, setComposerPrefill: calls.prefill, setComposerAutosend: calls.autosend }) } }))
import { startReadingAnalysis, deliverBoardReading } from './readingAnalysis'
import { beginNavigationIntent } from './navigationIntent'

beforeEach(() => { vi.clearAllMocks(); calls.create.mockResolvedValue('analysis-session'); calls.drain.mockReturnValue(true) })
describe('explicit reading analysis', () => {
  it('sends the selected data in a separate read-only session without composer mutations', async () => {
    const prompt = 'Analyze Synthetic A (12345) spend 12 USD'
    const intent = beginNavigationIntent()
    expect(await startReadingAnalysis(prompt, intent)).toBe('analysis-session')
    expect(calls.create).toHaveBeenCalledWith({ permissionMode: 'readonly' }, intent)
    expect(calls.enqueue).toHaveBeenCalledWith('analysis-session', { id: expect.any(String), text: prompt })
    expect(calls.select).toHaveBeenCalledWith('analysis-session', intent)
    expect(calls.drain).toHaveBeenCalledWith('analysis-session')
  })
  it('sends a late analysis to its own session without selecting it', async () => {
    let complete!: (id: string) => void
    calls.create.mockReturnValue(new Promise<string>(resolve => { complete = resolve }))
    const intent = beginNavigationIntent()
    const pending = startReadingAnalysis('Synthetic A', intent)
    beginNavigationIntent() // user moved to B while creation was pending
    complete('session-A')
    expect(await pending).toBe('session-A')
    expect(calls.select).not.toHaveBeenCalled()
    expect(calls.enqueue).toHaveBeenCalledWith('session-A', {id:expect.any(String), text:'Synthetic A'})
    expect(calls.drain).toHaveBeenCalledWith('session-A')
    expect(calls.prefill).not.toHaveBeenCalled()
  })
  it('does not queue or select anything when no session can be created', async () => {
    calls.create.mockResolvedValue(null)
    expect(await startReadingAnalysis('Analyze current readings')).toBeNull()
    expect(calls.enqueue).not.toHaveBeenCalled(); expect(calls.select).not.toHaveBeenCalled()
    expect(await startReadingAnalysis(' ')).toBeNull()
    expect(calls.create).toHaveBeenCalledTimes(1)
  })
  it('keeps foreground board reading on its original composer path', () => {
    const intent = beginNavigationIntent()
    expect(deliverBoardReading('session-A', 'Synthetic A', intent)).toBe('foreground')
    expect(calls.select).toHaveBeenCalledWith('session-A', intent)
    expect(calls.prefill).toHaveBeenCalledWith('Synthetic A')
    expect(calls.autosend).toHaveBeenCalledWith(true)
    expect(calls.enqueue).not.toHaveBeenCalled()
  })
  it('sends a late board reading to A without touching B’s composer', () => {
    const intent = beginNavigationIntent()
    beginNavigationIntent() // user chose B after the analysis was initiated
    expect(deliverBoardReading('session-A', 'Synthetic A', intent)).toBe('background')
    expect(calls.select).not.toHaveBeenCalled()
    expect(calls.prefill).not.toHaveBeenCalled()
    expect(calls.autosend).not.toHaveBeenCalled()
    expect(calls.enqueue).toHaveBeenCalledWith('session-A', {id:expect.any(String), text:'Synthetic A'})
    expect(calls.drain).toHaveBeenCalledWith('session-A')
  })
})
