import { describe, expect, it } from 'vitest'
import { parseModelsText } from '../components/CustomProvidersSection'

describe('parseModelsText', () => {
  it('parses one model per line, id only', () => {
    expect(parseModelsText('model-a\nmodel-b')).toEqual([
      { id: 'model-a', name: '' },
      { id: 'model-b', name: '' }
    ])
  })

  it('splits an optional display name at the first whitespace run', () => {
    expect(parseModelsText('claude-sonnet-4 Claude Sonnet 4')).toEqual([
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }
    ])
  })

  it('skips blank lines and trims', () => {
    expect(parseModelsText('\n  a  \n\n b \n')).toEqual([
      { id: 'a', name: '' },
      { id: 'b', name: '' }
    ])
  })

  it('dedupes by id, keeping the first occurrence', () => {
    expect(parseModelsText('a first\na second')).toEqual([{ id: 'a', name: 'first' }])
  })

  it('returns an empty list for empty input', () => {
    expect(parseModelsText('  \n ')).toEqual([])
  })
})
