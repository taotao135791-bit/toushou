import { withUserAccessToken } from '@larksuiteoapi/node-sdk'
import { describe, expect, it, vi } from 'vitest'
import { FeishuToolRegistry, capabilityFor } from './FeishuToolRegistry'

describe('FeishuToolRegistry', () => {
  it('keeps message tools on the app channel and maps document access correctly', () => {
    expect(capabilityFor('message_read')).toBe('messaging')
    expect(capabilityFor('message_search')).toBe('messaging')
    expect(capabilityFor('doc_read')).toBe('docs.read')
    expect(capabilityFor('doc_append')).toBe('docs.write')
    expect(capabilityFor('doc_list')).toBe('drive')
    expect(capabilityFor('doc_search')).toBe('drive')
  })

  it('passes user OAuth tokens only to user-scoped API requests', async () => {
    const request = vi.fn(async () => ({ code: 0, data: { title: 'brief' } }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async (capability) => capability === 'docs.read' ? 'user-token' : null
    )
    await expect(registry.execute({ action: 'doc_read', documentId: 'doc_1' })).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/open-apis/docx/v1/documents/doc_1/raw_content' }),
      withUserAccessToken('user-token')
    )
  })

  it('lists recent drive files with the drive capability token', async () => {
    const request = vi.fn(async () => ({ code: 0, data: { files: [{ name: 'a', token: 't' }] } }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async (capability) => capability === 'drive' ? 'drive-token' : null
    )
    await expect(registry.execute({ action: 'doc_list' })).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/open-apis/drive/v1/files',
        params: expect.objectContaining({ order_by: 'EditedTime', direction: 'DESC' })
      }),
      withUserAccessToken('drive-token')
    )
  })

  it('searches docs with a bounded keyword', async () => {
    const request = vi.fn(async () => ({ code: 0, data: { entities: [] } }))
    const channel = { rawClient: { request } }
    const registry = new FeishuToolRegistry(
      () => channel as never,
      () => true,
      async () => 'drive-token'
    )
    await expect(registry.execute({ action: 'doc_search', query: '  投放  ' })).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/open-apis/suite/docs-api/search/object',
        data: { search_key: '投放', count: 20, offset: 0 }
      }),
      withUserAccessToken('drive-token')
    )
  })
})
