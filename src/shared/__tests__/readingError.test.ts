import { describe, expect, it } from 'vitest'
import { isReadingErrorCode, readingFailure, READING_ERROR_DETAIL_LIMIT } from '../readingError'

describe('readingFailure', () => {
  it('keeps the code and drops an empty detail', () => {
    expect(readingFailure('no-credentials')).toEqual({ ok: false, error: 'no-credentials' })
    expect(readingFailure('api', '   ')).toEqual({ ok: false, error: 'api' })
  })

  it('bounds the technical detail', () => {
    const result = readingFailure('api', `  ${'x'.repeat(READING_ERROR_DETAIL_LIMIT + 20)}  `)
    expect(result.detail).toHaveLength(READING_ERROR_DETAIL_LIMIT)
  })

  it('recognizes only the stable codes', () => {
    expect(isReadingErrorCode('no-advertiser')).toBe(true)
    expect(isReadingErrorCode('报表接口返回的不是 JSON（HTTP 405）')).toBe(false)
  })
})
