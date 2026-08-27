import { describe, it, expect } from 'vitest'
import { defaultExportFileName } from '../exportPath'

const NOW = new Date(2026, 7, 5, 9, 7) // 2026-08-05 09:07 local time

describe('defaultExportFileName', () => {
  it('slugs the session title and appends a timestamp', () => {
    expect(defaultExportFileName('Fix the login bug', 'abcdef123456', NOW)).toBe(
      'omp-Fix-the-login-bug-20260805-0907.html'
    )
  })

  it('strips path-unsafe characters from the title', () => {
    expect(defaultExportFileName('a/b\\c:d*e?"f<g>h|i', 'id000000', NOW)).toBe(
      'omp-a-b-c-d-e-f-g-h-i-20260805-0907.html'
    )
  })

  it('keeps CJK titles intact', () => {
    expect(defaultExportFileName('修复 登录 问题', 'id000000', NOW)).toBe(
      'omp-修复-登录-问题-20260805-0907.html'
    )
  })

  it('falls back to the first 8 session id chars when the title is blank', () => {
    expect(defaultExportFileName('  ', 'abcdef1234567890', NOW)).toBe(
      'omp-abcdef12-20260805-0907.html'
    )
    expect(defaultExportFileName(undefined, 'abcdef1234567890', NOW)).toBe(
      'omp-abcdef12-20260805-0907.html'
    )
  })

  it('caps a long title at 40 chars and trims trailing dashes', () => {
    const name = defaultExportFileName('x'.repeat(80), 'id000000', NOW)
    expect(name).toBe(`omp-${'x'.repeat(40)}-20260805-0907.html`)
  })
})
