import { describe, expect, it } from 'vitest'
import { greetingBucket } from './time'

function at(h: number): Date {
  return new Date(2026, 8, 7, h, 0, 0)
}

describe('greetingBucket', () => {
  it('maps hours to the right time-of-day bucket', () => {
    expect(greetingBucket(at(5))).toBe('morning')
    expect(greetingBucket(at(10))).toBe('morning')
    expect(greetingBucket(at(11))).toBe('noon')
    expect(greetingBucket(at(13))).toBe('noon')
    expect(greetingBucket(at(14))).toBe('afternoon')
    expect(greetingBucket(at(17))).toBe('afternoon')
    expect(greetingBucket(at(18))).toBe('evening')
    expect(greetingBucket(at(22))).toBe('evening')
    expect(greetingBucket(at(23))).toBe('night')
    expect(greetingBucket(at(2))).toBe('night')
    expect(greetingBucket(at(4))).toBe('night')
  })
})
