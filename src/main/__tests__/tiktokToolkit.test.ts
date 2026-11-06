import { afterEach, describe, expect, it, vi } from 'vitest'
import type registerTikTokTools from '../../../resources/tiktok-toolkit/extensions/index'

type Tool = Parameters<Parameters<typeof registerTikTokTools>[0]['registerTool']>[0]

async function toolkit(): Promise<Tool[]> {
  vi.resetModules()
  vi.stubEnv('TOUSHOU_TIKTOK', 'http://127.0.0.1:9999/synthetic-session')
  const register = (await import('../../../resources/tiktok-toolkit/extensions/index')).default
  const registered: Tool[] = []
  register({ registerTool: tool => { registered.push(tool) } })
  return registered
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('TikTok toolkit compatibility and failure guidance', () => {
  it('prefers correctly spelled names and keeps compact aliases for persisted conversations', async () => {
    const tools = await toolkit()
    expect(tools.map(tool => tool.name)).toEqual(['toushou_tiktok_update', 'toushou_tiktok_status', 'touhou_tiktok_update', 'touhou_tiktok_status'])
    for (const suffix of ['update', 'status']) {
      const canonical = tools.find(tool => tool.name === `toushou_tiktok_${suffix}`)!
      const legacy = tools.find(tool => tool.name === `touhou_tiktok_${suffix}`)!
      expect(legacy.execute).toBe(canonical.execute)
      expect(legacy.parameters).toBe(canonical.parameters)
      expect(legacy.approval).toBe(canonical.approval)
      expect(legacy.description.length).toBeLessThan(80)
      expect(legacy.description).toContain(canonical.name)
    }
    expect(tools[0].approval).toBe('write')
    expect(tools[0].description).toContain('permission-denied 表示本地写入未获允许')
    expect(tools[1].description).toContain('不能臆测存在两套独立授权')
  })

  it('routes canonical and legacy updates through the same Main bridge and preserves permission reasons', async () => {
    const tools = await toolkit()
    const denial = { ok: false, error: 'permission-denied', reason: 'readonly-session', hint: 'Synthetic local permission hint' }
    const fetchMock = vi.fn(async () => ({ json: async () => denial }))
    vi.stubGlobal('fetch', fetchMock)
    for (const name of ['toushou_tiktok_update', 'touhou_tiktok_update']) {
      const tool = tools.find(candidate => candidate.name === name)!
      const result = await tool.execute('call', { advertiserId: '1234567890123456789', startDate: '2026-10-01', endDate: '2026-10-07', action: 'tiktok_status' })
      expect(JSON.parse(result.content[0].text)).toEqual(denial)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[0]).toBe('http://127.0.0.1:9999/synthetic-session')
      expect(JSON.parse(call[1].body as string)).toEqual({ advertiserId: '1234567890123456789', startDate: '2026-10-01', endDate: '2026-10-07', action: 'tiktok_update' })
    }
  })

  it('routes status aliases as reads and preserves the independent session capability', async () => {
    const tools = await toolkit()
    const status = { ok: true, status: { configured: true }, sessionAccess: { canUpdateDataset: false, reason: 'remote-readonly' } }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ action: 'tiktok_status' })
      return { json: async () => status }
    })
    vi.stubGlobal('fetch', fetchMock)
    for (const name of ['toushou_tiktok_status', 'touhou_tiktok_status']) {
      const tool = tools.find(candidate => candidate.name === name)!
      expect(tool.approval).toBe('read')
      expect(JSON.parse((await tool.execute('call', {})).content[0].text)).toEqual(status)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
