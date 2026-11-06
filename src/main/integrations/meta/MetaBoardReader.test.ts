import { describe, expect, it, vi } from 'vitest'
import { metaDailyRows, metaToolData, readMetaAccounts, readMetaSummary } from './MetaBoardReader'

const result = (data: unknown[], paging?: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ data, ...(paging ? { paging } : {}) }) }] })
const account = { id: 'act_123', name: 'Synthetic account', currency: 'USD', timezone: null }
const row = (day: string, extra = {}) => ({ account_id: '123', date_start: day, date_stop: day, spend: '1.25', impressions: '100', clicks: '2', ...extra })

describe('Meta native board read boundary', () => {
  it('accepts the observed FastMCP structured string wrapper', () => {
    const payload = { data: [row('2026-01-01')] }
    expect(metaToolData({ structuredContent: { result: JSON.stringify(payload) } })).toEqual(payload)
    expect(metaToolData({ structuredContent: { result: payload } })).toEqual(payload)
  })
  it('reads the observed hosted daily segmented report and refuses incomplete segments', async () => {
    const payload = { object_id: account.id, level: 'account', time_breakdown: 'day', total_segments: 1,
      time_range: { since: '2026-01-01', until: '2026-01-01' }, aggregates: { spend: 99 },
      segmented_metrics: [{ period: '2026-01-01', period_start: '2026-01-01', period_end: '2026-01-01', metrics: row('2026-01-01') }] }
    const callReadTool = vi.fn().mockResolvedValue({ structuredContent: { result: JSON.stringify(payload) } })
    expect((await readMetaSummary({ callReadTool }, account, 'yesterday')).rows[0].spend).toBe(1.25)
    expect(() => metaDailyRows({ ...payload, total_segments: 2 }, account.id)).toThrow()
    expect(() => metaDailyRows({ ...payload, object_id: 'act_456' }, account.id)).toThrow()
    expect(() => metaDailyRows({ ...payload, truncated: true }, account.id)).toThrow()
    expect(() => metaDailyRows({ ...payload, segmented_metrics: [{ ...payload.segmented_metrics[0], period_end: '2026-01-02' }] }, account.id)).toThrow()
  })
  it('preserves an empty daily segment as unknown instead of silently publishing a partial total', async () => {
    const payload = { object_id: account.id, level: 'account', time_breakdown: 'day', total_segments: 2,
      time_range: { since: '2026-01-01', until: '2026-01-02' }, segmented_metrics: [
        { period_start: '2026-01-01', period_end: '2026-01-01', metrics: row('2026-01-01') },
        { period_start: '2026-01-02', period_end: '2026-01-02', metrics: {} }
      ] }
    const summary = await readMetaSummary({ callReadTool: vi.fn().mockResolvedValue({ structuredContent: payload }) }, account, 'last3')
    expect(summary.rows).toEqual([
      { date: '2026-01-01', spend: 1.25, impressions: 100, clicks: 2 },
      { date: '2026-01-02', spend: null, impressions: null, clicks: null }
    ])
  })
  it('projects only safe account fields, preserves unknown timezone and reports partial account lists', async () => {
    const callReadTool = vi.fn().mockResolvedValue(result([{ ...account, secret: 'must-not-return' }], { next: 'https://example.invalid' }))
    const data = await readMetaAccounts({ callReadTool })
    expect(data.accounts).toEqual([account])
    expect(data.partial).toBe(true)
    expect(JSON.stringify(data)).not.toContain('secret')
  })
  it('uses daily account-level queries and follows cursors without following upstream URLs', async () => {
    const callReadTool = vi.fn().mockResolvedValueOnce(result([row('2026-01-01')], { next: 'https://untrusted.invalid/?access_token=secret', cursors: { after: 'cursor1' } })).mockResolvedValueOnce(result([row('2026-01-02', { spend: '0', clicks: undefined })]))
    const summary = await readMetaSummary({ callReadTool }, account, 'last3')
    expect(callReadTool.mock.calls[0]).toEqual(['get_insights', { object_id: 'act_123', level: 'account', time_range: 'last_3d', time_breakdown: 'day', limit: 100 }])
    expect(callReadTool.mock.calls[1][1].after).toBe('cursor1')
    expect(summary.rows[1]).toEqual({ date: '2026-01-02', spend: 0, impressions: 100, clicks: null })
    expect(JSON.stringify(summary)).not.toContain('access_token')
  })
  it('uses the exact board dates rather than provider presets, and rejects out-of-window rows', async () => {
    const callReadTool = vi.fn().mockResolvedValue(result([row('2026-01-01')]))
    const window = { start: '2026-01-01', end: '2026-01-01' }
    expect((await readMetaSummary({ callReadTool }, account, 'today', window)).start).toBe(window.start)
    expect(callReadTool.mock.calls[0][1].time_range).toEqual({ since: window.start, until: window.end })
    await expect(readMetaSummary({ callReadTool }, account, 'today', { start: '2026-01-02', end: '2026-01-02' })).rejects.toThrow(/范围/)
  })
  it.each([
    row('2026-01-01', { account_id: '456' }),
    row('2026-01-01', { date_stop: '2026-01-02' }),
    row('2026-02-30'),
    row('2026-01-01', { spend: 'NaN' }),
    row('2026-01-01', { clicks: -1 })
  ])('rejects mismatched or malformed readings', async bad => {
    await expect(readMetaSummary({ callReadTool: vi.fn().mockResolvedValue(result([bad])) }, account, 'today')).rejects.toThrow()
  })
  it('rejects duplicate days, overlong windows and incomplete pagination instead of publishing partial totals', async () => {
    for (const payload of [result([row('2026-01-01'), row('2026-01-01')]), result([row('2026-01-01'), row('2026-01-09')]), result([row('2026-01-01')], { next: 'untrusted' })]) {
      await expect(readMetaSummary({ callReadTool: vi.fn().mockResolvedValue(payload) }, account, 'last7')).rejects.toThrow()
    }
  })
  it('does not leak service errors or turn empty/missing data into zero', async () => {
    expect(() => metaToolData({ isError: true, content: [{ text: 'access_token=secret' }] })).toThrow(/查询失败/)
    expect(() => metaToolData({ content: [{ type: 'text', text: '{"error":"secret"}' }] })).toThrow(/格式不可用/)
    expect((await readMetaSummary({ callReadTool: vi.fn().mockResolvedValue(result([])) }, account, 'today')).rows).toEqual([])
  })
})
