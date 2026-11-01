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
  const deps = { getAccess: () => current, confirm: vi.fn<() => Promise<boolean | 'unavailable'>>(async () => true), refresh, status: () => ({} as never) }
  return { deps, refresh, revoke: () => { current = null }, changeAccess: (next: Partial<NonNullable<typeof current>>) => { if (current) current = { ...current, ...next } } }
}

describe('TikTok bridge session and scope', () => {
  it('does not expose credential hints or account identifiers in tool status', async () => {
    const f = fixture('readonly')
    f.deps.status = () => ({ configured: true, autoRefresh: false, refreshing: false, info: { tokenMasked: 'secret-fragment', advertiserIds: ['123'] } } as never)
    const result = await authorizeTikTokRequest('s', { action: 'tiktok_status' }, f.deps)
    expect(result).toMatchObject({ ok: true, status: { configured: true } })
    expect(JSON.stringify(result)).not.toContain('secret-fragment')
    expect(JSON.stringify(result)).not.toContain('advertiserIds')
    expect(result).toMatchObject({ sessionAccess: { canUpdateDataset: false, requiresConfirmation: false, reason: 'readonly-session' }, hint: expect.stringContaining('不代表 TikTok 授权失效') })
    expect(f.refresh).not.toHaveBeenCalled()
  })

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

  it('distinguishes readonly and remote sessions without attempting any report read', async () => {
    for (const [f, reason] of [[fixture('readonly'), 'readonly-session'], [fixture('full', true), 'remote-readonly']] as const) {
      expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ error: 'permission-denied', reason, hint: expect.stringContaining('不代表 TikTok 授权失效') })
      expect(f.refresh).not.toHaveBeenCalled()
    }
  })

  it('distinguishes user refusal and unavailable confirmation and does not refresh', async () => {
    const f = fixture('ask')
    f.deps.confirm.mockResolvedValueOnce(false)
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ error: 'permission-denied', reason: 'user-declined' })
    f.deps.confirm.mockResolvedValueOnce('unavailable')
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ error: 'permission-denied', reason: 'confirmation-unavailable' })
    f.deps.confirm.mockRejectedValueOnce(new Error('private UI details'))
    const unavailable = await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)
    expect(unavailable).toMatchObject({ error: 'permission-denied', reason: 'confirmation-unavailable' })
    expect(JSON.stringify(unavailable)).not.toContain('private UI details')
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('reports that ask mode can update only after approval and still enforces approval', async () => {
    const f = fixture('ask')
    const status = await authorizeTikTokRequest('s', { action: 'tiktok_status' }, f.deps)
    expect(status).toMatchObject({ sessionAccess: { canUpdateDataset: true, requiresConfirmation: true } })
    expect(f.deps.confirm).not.toHaveBeenCalled()
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ ok: true })
    expect(f.deps.confirm).toHaveBeenCalledOnce()
    expect(f.refresh).toHaveBeenCalledOnce()
  })

  it('rejects a permission change while awaiting approval before reading any report', async () => {
    const f = fixture('ask')
    f.deps.confirm.mockImplementationOnce(async () => {
      f.changeAccess({ mode: 'readonly' })
      return true
    })
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ ok: false, error: 'permission-denied', reason: 'session-permission-changed' })
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('explains an unavailable local session without blaming TikTok credentials', async () => {
    const f = fixture()
    f.revoke()
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ ok: false, error: 'no-session', hint: expect.stringContaining('不代表 TikTok 授权失效') })
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
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toMatchObject({ error: 'permission-denied', reason: 'session-permission-changed', hint: expect.stringContaining('不代表 TikTok 授权失效') })
  })

  it.each([{ mode: 'readonly' as const }, { mode: 'ask' as const }, { remoteReadonly: true }, { cwd: '/other-workspace' }])('refuses a permission or workspace change during the report read: %j', async change => {
    const f = fixture('full')
    f.refresh.mockImplementationOnce(async options => {
      f.changeAccess(change)
      return options?.beforeWrite?.()
        ? { ok: true as const, status: {} as never, rowCount: 2, truncated: false, legacyBackups: [] }
        : { ok: false as const, error: 'permission-denied', status: {} as never }
    })
    const result = await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)
    expect(result).toMatchObject({ ok: false, error: 'permission-denied', reason: 'session-permission-changed' })
    expect(JSON.stringify(result)).not.toContain('/other-workspace')
  })

  it('does not misclassify credential errors as a session permission failure', async () => {
    const f = fixture()
    f.refresh.mockResolvedValueOnce({ ok: false as const, error: 'token-expired', status: {} as never })
    expect(await authorizeTikTokRequest('s', { action: 'tiktok_update' }, f.deps)).toEqual({ ok: false, error: 'token-expired', dataset: 'TikTok 报表' })
  })
})
