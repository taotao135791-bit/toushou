import { describe, expect, it } from 'vitest'
import { isUiAnswer, MAX_UI_ANSWER_VALUE_LENGTH } from '../uiAnswer'

describe('isUiAnswer', () => {
  it('accepts only the three exact answer variants', () => {
    expect(isUiAnswer({ cancelled: true })).toBe(true)
    expect(isUiAnswer({ confirmed: false })).toBe(true)
    expect(isUiAnswer({ value: 'line one\nline two' })).toBe(true)
  })

  it('rejects ambiguous, malformed, inherited, and oversized renderer payloads', () => {
    const inherited = Object.create({ cancelled: true })
    for (const value of [
      null,
      [],
      {},
      { cancelled: false },
      { confirmed: 'true' },
      { value: 1 },
      { cancelled: true, confirmed: false },
      { value: 'ok', extra: true },
      inherited,
      { value: 'x'.repeat(MAX_UI_ANSWER_VALUE_LENGTH + 1) }
    ]) {
      expect(isUiAnswer(value)).toBe(false)
    }
  })
})
