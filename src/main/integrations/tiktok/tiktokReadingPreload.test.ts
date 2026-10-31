import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../../shared/constants'
import { parseTikTokAdvertiserIdList } from '../../../shared/tiktokReport'

const bridge = vi.hoisted(() => ({ api: null as null | { ttReadingSummary(input: { advertiserIds?: string; range?: string; requestId?: string }): Promise<unknown>; ttReadingToday(input: { advertiserId?: string; range?: string; requestId?: string }): Promise<unknown> }, invoke: vi.fn(async () => ({})) }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge.api) => { bridge.api = value } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}))
import '../../preload'

describe('TikTok reading preload scope', () => {
  it('preserves invalid explicit account scope as invalid rather than broadening to all', async () => {
    for (const value of ['1'.repeat(14001), 42 as unknown as string]) {
      await bridge.api!.ttReadingSummary({ advertiserIds: value, requestId: 'fixture' })
      const [channel, payload] = bridge.invoke.mock.calls.at(-1) as unknown as [string, { advertiserIds: string; requestId: string }]
      expect(channel).toBe(IPC_CHANNELS.TT_READING_SUMMARY)
      expect(payload.requestId).toBe('fixture')
      expect(payload.advertiserIds).not.toBe('')
      expect(parseTikTokAdvertiserIdList(payload.advertiserIds)).toBeNull()
    }
  })
  it('passes a 500-account explicit selection intact', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => String(7300000000 + i))
    await bridge.api!.ttReadingSummary({ advertiserIds: ids.join(', ') })
    const [, payload] = bridge.invoke.mock.calls.at(-1) as unknown as [string, { advertiserIds: string }]
    expect(parseTikTokAdvertiserIdList(payload.advertiserIds)).toEqual(ids)
  })
  it('preserves an explicit single ID and forwards invalid IDs as invalid', async () => {
    await bridge.api!.ttReadingToday({ advertiserId: '7300001', range: 'today', requestId: 'fixture' })
    expect(bridge.invoke.mock.calls.at(-1)).toEqual([IPC_CHANNELS.TT_READING_TODAY, { advertiserId: '7300001', range: 'today', requestId: 'fixture' }])
    await bridge.api!.ttReadingToday({ advertiserId: 42 as unknown as string })
    expect(bridge.invoke.mock.calls.at(-1)).toEqual([IPC_CHANNELS.TT_READING_TODAY, { advertiserId: '!', range: '' }])
  })
})
