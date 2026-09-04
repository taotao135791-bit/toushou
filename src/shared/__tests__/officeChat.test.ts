import { describe, expect, it } from 'vitest'
import { buildOfficeChatPrompt, snapshotHasData } from '../officeChat'

function cell(v: string | number): { v: string | number } {
  return { v }
}

const workbook = {
  id: 'workbook',
  name: 'Q3 spend',
  sheetOrder: ['s1', 's2'],
  sheets: {
    s1: {
      id: 's1',
      name: 'Daily',
      hidden: 0,
      cellData: {
        0: { 0: cell('Date'), 1: cell('Spend'), 2: cell('CTR') },
        1: { 0: cell('2026-08-01'), 1: cell(42), 2: cell('secret-row-value') },
        4: { 0: cell('total-row') }
      }
    },
    s2: {
      id: 's2',
      name: 'Raw export',
      hidden: 1,
      cellData: {}
    }
  }
}

describe('buildOfficeChatPrompt', () => {
  it('summarizes structure and header samples without data rows', () => {
    const prompt = buildOfficeChatPrompt(workbook, { language: 'en' })
    expect(prompt).toContain('Workbook: Q3 spend')
    expect(prompt).toContain('Sheets (2):')
    expect(prompt).toContain('- Daily: 5 rows x 3 cols; headers: Date, Spend, CTR')
    expect(prompt).toContain('- Raw export (hidden): empty')
    expect(prompt).not.toContain('secret-row-value')
    expect(prompt).not.toContain('2026-08-01')
  })

  it('prefers the explicit name option and renders a Chinese variant', () => {
    const prompt = buildOfficeChatPrompt(workbook, { name: 'report.xlsx', language: 'zh' })
    expect(prompt).toContain('工作簿：report.xlsx')
    expect(prompt).toContain('工作表（2 个）：')
    expect(prompt).toContain('表头：Date, Spend, CTR')
    expect(prompt).toContain('（隐藏）: 空表')
  })

  it('returns null when the snapshot holds no sheets', () => {
    expect(buildOfficeChatPrompt(null)).toBeNull()
    expect(buildOfficeChatPrompt({})).toBeNull()
    expect(buildOfficeChatPrompt({ sheets: {} })).toBeNull()
  })

  it('bounds the sheet list', () => {
    const sheets: Record<string, unknown> = {}
    const sheetOrder: string[] = []
    for (let i = 0; i < 60; i += 1) {
      sheetOrder.push(`s${i}`)
      sheets[`s${i}`] = { id: `s${i}`, name: `Sheet ${i}`, hidden: 0, cellData: {} }
    }
    const prompt = buildOfficeChatPrompt({ name: 'big', sheetOrder, sheets }, { language: 'en' })
    expect(prompt).toContain('Sheets (60):')
    expect(prompt).toContain('10 more sheets omitted')
    expect(prompt).not.toContain('Sheet 59')
  })
})

describe('snapshotHasData', () => {
  it('detects valued cells and ignores empty structure', () => {
    expect(snapshotHasData(workbook)).toBe(true)
    expect(snapshotHasData({ sheets: { s1: { cellData: { 0: { 0: {} } } } } })).toBe(false)
    expect(snapshotHasData(undefined)).toBe(false)
  })

  it('reads rich-text cell bodies', () => {
    const rich = { sheets: { s1: { cellData: { 0: { 0: { p: { body: { dataStream: 'hello' } } } } } } } }
    expect(snapshotHasData(rich)).toBe(true)
  })
})
