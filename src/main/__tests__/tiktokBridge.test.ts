import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }))
vi.mock('../integrations/tiktok/TikTokRefreshService', () => ({ tiktokReportService: {} }))

import { authorizeTikTokRequest } from '../tiktokBridge'
import type { PermissionMode } from '../../shared/types'

function fixture(mode: PermissionMode = 'full', remoteReadonly = false) {
  let current: { cwd: string; mode: PermissionMode; remoteReadonly: boolean } | null = { cwd: '/workspace', mode, remoteReadonly }
  const refresh = vi.fn(async (options?: { advertiserId?: string; beforeWrite?: () => boolean }) => {
    if (!options?.beforeWrite?.()) return { ok: false as const, error: 'permission-denied', status: {} as never }
    return { ok: true as const, status: {} as never, rowCount: 2, truncated: false, legacyBackups: ['历史备份'] }
  })
  const deps = { getAccess: () => current, confirm: vi.fn(async () => true), refresh, status: () => ({} as never) }
  return { deps, refresh, revoke: () => { current = null } }
}

describe('TikTok bridge session and scope', () => {
  it('forwards a string account ID and reports migration backups', async () => {
    const f = fixture()
    const result = await authorizeTikTokRequest('session', { action: 'tiktok_update', advertiserId: '1234567890123456789', days: 7 }, f.deps)
    expect(f.refresh).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: '1234567890123456789' }))
    expect(result).toMatchObject({ ok: true, legacyBackups: ['历史备份'] })
  })

  it('rejects imprecise account IDs and unsupported ranges before reading', async () => {
    const f = fixture()
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update', advertiserId: 1234567890123456789 }, f.deps)).toMatchObject({ error: 'invalid-advertiser-id' })
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update', days: 28 }, f.deps)).toMatchObject({ error: 'unsupported-range' })
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('refuses readonly and remote sessions and asks for consent when required', async () => {
    for (const f of [fixture('readonly'), fixture('full', true)]) {
      expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ error: 'permission-denied' })
      expect(f.refresh).not.toHaveBeenCalled()
    }
    const f = fixture('ask')
    f.deps.confirm.mockResolvedValueOnce(false)
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ error: 'permission-denied' })
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('rechecks permission immediately before a delayed dataset write', async () => {
    const f = fixture()
    f.refresh.mockImplementationOnce(async options => {
      f.revoke()
      return options?.beforeWrite?.()
        ? { ok: true as const, status: {} as never, rowCount: 2, truncated: false, legacyBackups: [] }
        : { ok: false as const, error: 'permission-denied', status: {} as never }
    })
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ error: 'permission-denied' })
  })
})
