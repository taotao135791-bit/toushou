import { describe, expect, it } from 'vitest'
import { serializeBoundedJson } from './boundedJson'

describe('serializeBoundedJson', () => {
  it('returns valid JSON while retaining the envelope and truncation metadata', () => {
    const encoded = serializeBoundedJson({ ok: true, error: 'should-not-drop', text: '🙂'.repeat(20_000), rows: Array.from({ length: 100 }, (_, i) => ({ i, value: 'x'.repeat(200) })) }, 2_000)
    const value = JSON.parse(encoded) as Record<string, unknown>
    expect(value.ok).toBe(true)
    expect(value.truncated).toBe(true)
    expect(value.truncation).toBeDefined()
    expect(encoded.length).toBeLessThan(4_000)
  })

  it('preserves small nested objects unchanged', () => {
    const input = { ok: false, error: 'panel-hidden', details: { url: 'https://example.com', count: 2 } }
    expect(JSON.parse(serializeBoundedJson(input))).toEqual(input)
  })
})
