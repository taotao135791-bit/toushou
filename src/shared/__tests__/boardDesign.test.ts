import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOARD_DESIGN_MARKDOWN,
  formatBoardDesign,
  parseBoardDesign
} from '../boardDesign'
import { BoardDesignSpec } from '../types'

const VALID = `# Board Design

## board
background: #101014
grid: dots

## widget
accent: #7aa2f7
surface: #1f2430
text: #e6e6e6
border: #2a2f3a
radius: 12
padding: 12
titleAlign: left
shadow: soft
`

describe('parseBoardDesign', () => {
  it('parses a full valid document', () => {
    const { spec, issues } = parseBoardDesign(VALID)
    expect(issues).toEqual([])
    expect(spec).toEqual({
      board: { background: '#101014', grid: 'dots' },
      widget: {
        accent: '#7aa2f7',
        surface: '#1f2430',
        text: '#e6e6e6',
        border: '#2a2f3a',
        radius: 12,
        padding: 12,
        titleAlign: 'left',
        shadow: 'soft'
      }
    })
  })

  it('normalizes hex colors to lowercase like the board validators', () => {
    const { spec, issues } = parseBoardDesign('## widget\naccent: #AABBCC\n')
    expect(issues).toEqual([])
    expect(spec.widget.accent).toBe('#aabbcc')
  })

  it('warns on unknown keys and keeps them out of the spec', () => {
    const { spec, issues } = parseBoardDesign('## widget\naccent: #7aa2f7\nfontSize: 14\n')
    expect(spec.widget).toEqual({ accent: '#7aa2f7' })
    expect(issues).toEqual([{ level: 'warning', line: 3, message: 'Unknown widget key "fontSize".' }])
  })

  it('warns on a board key used in the widget section (and vice versa)', () => {
    const { spec, issues } = parseBoardDesign('## widget\nbackground: #101014\n')
    expect(spec.widget).toEqual({})
    expect(issues[0].level).toBe('warning')
  })

  it('errors on invalid values and drops only that field', () => {
    const { spec, issues } = parseBoardDesign('## widget\naccent: red\nradius: 12\n')
    expect(spec.widget).toEqual({ radius: 12 })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ level: 'error', line: 2 })
  })

  it('rejects non-6-digit hex colors', () => {
    for (const bad of ['#abc', '#aabbccdd', 'aabbcc', '#gggggg']) {
      const { spec, issues } = parseBoardDesign(`## widget\naccent: ${bad}\n`)
      expect(spec.widget.accent).toBeUndefined()
      expect(issues[0]?.level).toBe('error')
    }
  })

  it('enforces the radius/padding bounds of BoardWidgetStyle', () => {
    const cases: [string, string, boolean][] = [
      ['radius', '0', true],
      ['radius', '32', true],
      ['radius', '33', false],
      ['radius', '-1', false],
      ['radius', '12.5', false],
      ['radius', '12px', false],
      ['padding', '6', true],
      ['padding', '32', true],
      ['padding', '5', false]
    ]
    for (const [key, value, ok] of cases) {
      const { spec, issues } = parseBoardDesign(`## widget\n${key}: ${value}\n`)
      expect(issues.length === 0).toBe(ok)
      if (ok) expect(spec.widget[key as 'radius' | 'padding']).toBe(Number(value))
    }
  })

  it('rejects invalid enum values', () => {
    for (const line of ['titleAlign: justify', 'shadow: heavy']) {
      const { spec, issues } = parseBoardDesign(`## widget\n${line}\n`)
      expect(spec.widget).toEqual({})
      expect(issues[0]?.level).toBe('error')
    }
    const grid = parseBoardDesign('## board\ngrid: diagonal\n')
    expect(grid.spec.board).toEqual({})
    expect(grid.issues[0]?.level).toBe('error')
  })

  it('ignores other sections and their lines', () => {
    const { spec, issues } = parseBoardDesign('# Board Design\n\n## notes\nanything: here\nradius: 99\n\n## widget\nradius: 10\n')
    expect(issues).toEqual([])
    expect(spec.widget.radius).toBe(10)
  })

  it('treats "> " lines and blank lines as comments', () => {
    const { spec, issues } = parseBoardDesign('## board\n> background: this is a comment\n\nbackground: #101014\n')
    expect(issues).toEqual([])
    expect(spec.board).toEqual({ background: '#101014' })
  })

  it('warns on unrecognized text lines inside a section', () => {
    const { issues } = parseBoardDesign('## widget\nnot a key value line\n')
    expect(issues).toHaveLength(1)
    expect(issues[0].level).toBe('warning')
  })

  it('parses the shipped template to an empty spec with no issues', () => {
    const { spec, issues } = parseBoardDesign(DEFAULT_BOARD_DESIGN_MARKDOWN)
    expect(issues).toEqual([])
    expect(spec).toEqual({ board: {}, widget: {} })
  })
})

describe('formatBoardDesign', () => {
  it('round-trips through parseBoardDesign', () => {
    const spec: BoardDesignSpec = {
      board: { background: '#101014', grid: 'lines' },
      widget: { accent: '#7aa2f7', radius: 0, padding: 32, titleAlign: 'right', shadow: 'strong' }
    }
    const { spec: parsed, issues } = parseBoardDesign(formatBoardDesign(spec))
    expect(issues).toEqual([])
    expect(parsed).toEqual(spec)
  })

  it('formats an empty spec as a bare document', () => {
    const empty: BoardDesignSpec = { board: {}, widget: {} }
    expect(formatBoardDesign(empty)).toBe('# Board Design\n')
    expect(parseBoardDesign(formatBoardDesign(empty))).toEqual({ spec: empty, issues: [] })
  })
})
