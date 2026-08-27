import { PromptImage } from '../shared/types'

/**
 * Main-process validation of prompt images arriving over IPC. The renderer is
 * untrusted — it must not be able to ship arbitrary bytes / unbounded payloads
 * / unsupported MIME through to the runtime. Pure functions (no Electron), so
 * they are unit-testable.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_COUNT = 4
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

/** MIME types the runtime actually supports for prompt images. */
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// eslint-disable-next-line no-control-regex
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Approximate decoded byte size of a base64 payload (strips a data: URL prefix). */
export function base64DecodedBytes(data: string): number {
  const clean = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - pad
}

/**
 * Accept only well-formed prompt images: bounded count, allowlisted MIME, valid
 * base64, per-image and total decoded-byte caps. Anything invalid is dropped
 * (never passed through); returns undefined when nothing survives.
 */
export function sanitizeImages(images: unknown): PromptImage[] | undefined {
  if (!Array.isArray(images)) return undefined
  const out: PromptImage[] = []
  let total = 0
  for (const img of images as Partial<PromptImage>[]) {
    if (!img || typeof img.data !== 'string' || typeof img.mimeType !== 'string') continue
    if (out.length >= MAX_IMAGE_COUNT) break
    if (!ALLOWED_IMAGE_MIME.has(img.mimeType)) continue
    const clean = img.data.includes(',') ? img.data.slice(img.data.indexOf(',') + 1) : img.data
    if (!BASE64_RE.test(clean) || clean.length % 4 !== 0) continue
    const bytes = base64DecodedBytes(img.data)
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) continue
    if (total + bytes > MAX_TOTAL_IMAGE_BYTES) break
    total += bytes
    out.push({ type: 'image', data: img.data, mimeType: img.mimeType })
  }
  return out.length ? out : undefined
}
