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

  it('downgrades verified semantics and reports the paths of omitted data', () => {
    const encoded = serializeBoundedJson({
      ok: true,
      verified: true,
      text: '投手'.repeat(10_000),
      reading: { rows: Array.from({ length: 80 }, (_, i) => ({ name: `campaign-${i}`, note: 'x'.repeat(500) })) }
    }, 2_000)
    const value = JSON.parse(encoded) as Record<string, any>
    expect(value.truncated).toBe(true)
    expect(value.verified).toBe(false)
    expect(value.verification).toEqual({ status: 'partial', reason: 'transport-truncated' })
    expect(value.truncation.fields.some((field: Record<string, unknown>) => field.path === '$.text')).toBe(true)
    expect(value.truncation.fields.some((field: Record<string, unknown>) => field.path === '$.reading.rows')).toBe(true)
  })
})
