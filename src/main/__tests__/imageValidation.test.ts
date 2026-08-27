import { describe, it, expect } from 'vitest'
import { sanitizeImages, base64DecodedBytes, MAX_IMAGE_COUNT } from '../imageValidation'

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64')
}

describe('sanitizeImages (main-process IPC validation)', () => {
  it('accepts a valid png image', () => {
    const out = sanitizeImages([{ type: 'image', data: b64('png-bytes'), mimeType: 'image/png' }])
    expect(out).toHaveLength(1)
  })

  it('rejects an unsupported MIME type', () => {
    expect(sanitizeImages([{ data: b64('x'), mimeType: 'image/svg+xml' }])).toBeUndefined()
  })

  it('rejects invalid base64', () => {
    expect(sanitizeImages([{ data: '!!!not-base64!!!', mimeType: 'image/png' }])).toBeUndefined()
  })

  it('caps the image count', () => {
    const images = Array.from({ length: MAX_IMAGE_COUNT + 3 }, () => ({
      type: 'image' as const,
      data: b64('x'),
      mimeType: 'image/png'
    }))
    const out = sanitizeImages(images)
    expect(out).toHaveLength(MAX_IMAGE_COUNT)
  })

  it('rejects an oversized single image (decoded bytes)', () => {
    // 11 MB decoded → over the 10 MB per-image cap.
    const huge = Buffer.alloc(11 * 1024 * 1024, 0x41).toString('base64')
    expect(sanitizeImages([{ data: huge, mimeType: 'image/png' }])).toBeUndefined()
  })

  it('caps total decoded bytes across images', () => {
    const each = Buffer.alloc(7 * 1024 * 1024, 0x42).toString('base64')
    const out = sanitizeImages([
      { data: each, mimeType: 'image/png' },
      { data: each, mimeType: 'image/png' },
      { data: each, mimeType: 'image/png' }
    ])
    // 7 MB * 3 = 21 MB > 20 MB total; only the first two fit.
    expect(out?.length).toBeLessThan(3)
  })
})

describe('base64DecodedBytes', () => {
  it('estimates decoded size from the base64 length', () => {
    expect(base64DecodedBytes(b64('hello'))).toBe(5)
  })
})
