import { describe, expect, it, vi } from 'vitest'
import { getWorkspaceOperation, listWorkspaceOperations, parseWorkspaceArgs, projectWorkspaceResult, workspaceArguments } from './workspaceOperations'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

describe('reviewed DingTalk workspace catalog', () => {
  it('discovers only registered operations and exposes business parameters separately from fixed flags', () => {
    expect(listWorkspaceOperations()).toMatchObject({ version: '1.0.69', services: expect.arrayContaining([expect.objectContaining({ service: 'sheet' })]) })
    expect(listWorkspaceOperations('sheet')).toMatchObject({ operations: expect.any(Array) })
    expect(listWorkspaceOperations('sheet', 'sheet.range.read')).toMatchObject({ id: 'sheet.range.read', effect: 'read', params: expect.objectContaining({ node: expect.any(Object) }) })
    expect(listWorkspaceOperations('contact', 'sheet.range.read')).toBeNull()
    expect(getWorkspaceOperation('auth.login')).toBeUndefined()
    expect(parseWorkspaceArgs('mcp.call', {})).toBeNull()
    expect(parseWorkspaceArgs('sheet.range.read', {})).toBeNull()
  })

  it('accepts only named, bounded inputs and preserves ordinary Unicode data', () => {
    const id = 'sheet.range.read'
    const args = { node: 'node-123', 'sheet-id': '演示表', range: 'A1:D4' }
    expect(parseWorkspaceArgs(id, args)).toEqual(args)
    for (const node of ['@report', ' @sample.csv', '-', '--profile=next', '/tmp/report', 'C:\\local\\file', '../local', 'file:///local', 'q\0z', 'n'.repeat(30_000)]) {
      expect(parseWorkspaceArgs(id, { ...args, node })).toBeNull()
    }
    for (const key of ['profile', 'args', 'output', 'yes', 'format', 'constructor', '__proto__']) {
      expect(parseWorkspaceArgs(id, { ...args, [key]: true })).toBeNull()
    }
  })

  it('accepts literal office data and ordinary formulas, while rejecting active external formulas and invalid JSON input', () => {
    const id = 'sheet.range.update'
    const args = { node: 'node', 'sheet-id': 's', range: 'A1:B2' }
    const values = [['https://example.com/plan', '@姓名', '-'], [1, -2, '+7'],
      ['=SUM(A2:B2)', '=AVERAGE(A2:B2)', '=IF(A2>0,"好","")']]
    expect(parseWorkspaceArgs(id, { ...args, values })).toEqual({ ...args, values })
    const styled = { type: 'text', text: '标题', cellStyles: { fontWeight: 'bold' } }
    const rich = { type: 'richText', texts: [{ type: 'link', text: '示例', link: 'https://example.org' }] }
    const mixed = [['', {}, false], [styled, rich, '=SUM(A1:C1)']]
    const parsed = parseWorkspaceArgs(id, { ...args, values: mixed })
    expect(parsed).toBeTruthy()
    const encoded = workspaceArguments(getWorkspaceOperation(id)!, parsed!).find(arg => arg.startsWith('--values='))!
    expect(JSON.parse(encoded.slice('--values='.length))).toEqual([
      [{ type: 'text', text: '' }, {}, { type: 'text', text: 'false' }],
      [styled, rich, { type: 'text', text: '=SUM(A1:C1)' }]
    ])
    for (const unsafe of ['@data.json', JSON.stringify(values), [['=IMPORTDATA("https://example.invalid")']],
      [[{ formula: 'WEBSERVICE("https://example.invalid")' }]], [Array(1500).fill(1)], JSON.parse('{"__proto__":{"x":1}}')]) {
      expect(parseWorkspaceArgs(id, { ...args, values: unsafe })).toBeNull()
    }
    const columns = { action: '跟进', file: '演示报告.pdf', path: '内部/交付', link: 'https://example.com/', text: '@同事' }
    const update = { 'base-id': 'b', 'table-id': 't', 'record-ids': 'r', cells: columns }
    expect(parseWorkspaceArgs('aitable.record.batch-update', update)).toEqual(update)
    expect(parseWorkspaceArgs('sheet.chart.create', { node: 'n', 'sheet-id': 's', properties: { actions: [{ webhook: 'https://example.com' }] } })).toBeNull()
  })

  it('strips credentials, CLI recovery commands and signed URL parameters without dropping the pagination cursor', () => {
    const data = { id: 'row', auth: { accessToken: 'synthetic-private' }, headers: { 'Set-Cookie': 'synthetic-private' },
      next_command: 'dws tool synthetic-private', text: '{"client_secret":"synthetic-private"}',
      url: 'https://demo:synthetic-private@example.test/p?q=t&Signature=synthetic-private',
      meta: { pagination: { next_token: 'cursor-2' } } }
    const projected = projectWorkspaceResult(data)
    expect(projected).toMatchObject({ id: 'row', meta: { pagination: { next_token: 'cursor-2' } } })
    expect(JSON.stringify(projected)).not.toContain('synthetic-private')
    expect(Buffer.byteLength(JSON.stringify(projectWorkspaceResult({ rows: Array(500).fill({ value: 'h'.repeat(500) }) })))).toBeLessThanOrEqual(24_000)
  })

  it('constrains chart widgets to ordinary business chart types, field aggregations and numeric placement', () => {
    const id = 'aitable.chart.create'
    const config = { name: '状态分布', chartType: 'PIE', sheet: 'table', measureType: 'field',
      measure: [{ value: 'v', externalValue: [{ type: 'formula', value: 'count' }] }], dimension: [{ value: 'd', externalValue: [] }] }
    const args = { 'base-id': 'base', 'dashboard-id': 'dashboard', config, layout: { x: 0, y: 0, w: 12, h: 4 } }
    expect(parseWorkspaceArgs(id, args)).toEqual(args)
    for (const chart of [{ ...config, chartType: 'IFRAME' }, { ...config, url: 'https://example.org' },
      { ...config, measure: [{ value: 'v', externalValue: [{ type: 'formula', value: 'remote-action' }] }] }]) {
      expect(parseWorkspaceArgs(id, { ...args, config: chart })).toBeNull()
    }
    expect(parseWorkspaceArgs(id, { ...args, layout: { x: '0' } })).toBeNull()
    expect(parseWorkspaceArgs('mind.create', { name: '示例', 'request-id': 'r', source: [] })).toBeNull()
  })
})
