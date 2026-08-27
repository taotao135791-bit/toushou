import { describe, it, expect } from 'vitest'
import { headTailLines, headTailChars, isLargeText } from './retention'

describe('headTailLines', () => {
  it('returns the whole text when it fits the budget', () => {
    const text = 'one\ntwo\nthree'
    const result = headTailLines(text, 5, 5)
    expect(result.truncated).toBe(false)
    expect(result.head).toBe(text)
    expect(result.hidden).toBe(0)
  })

  it('keeps head and tail with an exact hidden count', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const result = headTailLines(lines.join('\n'), 3, 2)
    expect(result.truncated).toBe(true)
    expect(result.head.split('\n')).toEqual(['line 0', 'line 1', 'line 2'])
    expect(result.tail.split('\n')).toEqual(['line 98', 'line 99'])
    expect(result.hidden).toBe(95)
  })

  it('never cuts a multi-byte codepoint (splits on line boundaries)', () => {
    const text = '你好世界\n第二行\n第三行\n第四行'
    const result = headTailLines(text, 1, 1)
    expect(result.truncated).toBe(true)
    expect(result.head).toBe('你好世界')
    expect(result.tail).toBe('第四行')
  })
})

describe('headTailChars', () => {
  it('returns the whole text when it fits the budget', () => {
    const text = 'short single line'
    const result = headTailChars(text, 100, 20)
    expect(result.truncated).toBe(false)
    expect(result.head).toBe(text)
    expect(result.hidden).toBe(0)
  })

  it('retains head/tail of a single enormous line by char count', () => {
    const text = 'x'.repeat(10_000)
    const result = headTailChars(text, 100, 100)
    expect(result.truncated).toBe(true)
    expect(result.hiddenUnit).toBe('chars')
    expect(result.head.length).toBe(100)
    expect(result.tail.length).toBe(100)
    expect(result.hidden).toBe(10_000 - 200)
  })

  it('never splits a surrogate pair (emoji)', () => {
    // 100 emoji (each 2 UTF-16 code units), cut at an odd boundary.
    const text = '😀'.repeat(100)
    const result = headTailChars(text, 11, 10)
    // The head must end on a complete codepoint (even number of code units).
    expect(result.head.length % 2).toBe(0)
    expect(result.tail.length % 2).toBe(0)
  })
})

describe('isLargeText', () => {
  it('is large by line count OR char count', () => {
    expect(isLargeText(Array.from({ length: 201 }, () => 'x').join('\n'), 200, 100_000)).toBe(true)
    expect(isLargeText('x'.repeat(100_001), 200, 100_000)).toBe(true)
    expect(isLargeText('small', 200, 100_000)).toBe(false)
    expect(isLargeText('', 200, 100_000)).toBe(false)
  })
})

