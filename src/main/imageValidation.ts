import { PromptImage } from '../shared/types'

/**
 * Main-process validation of prompt images arriving over IPC. The renderer is
 * untrusted — it must not be able to ship arbitrary bytes / unbounded payloads
 * / unsupported MIME through to the runtime. Pure functions (no Electron), so
 * they are unit-testable.
 */

export { base64DecodedBytes, MAX_IMAGE_COUNT, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../shared/promptImages'
import { base64DecodedBytes, isPromptImageMime, MAX_IMAGE_COUNT, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../shared/promptImages'

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

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
    if (!isPromptImageMime(img.mimeType)) continue
    const prefix = 'data:' + img.mimeType + ';base64,'
    const clean = img.data.startsWith(prefix) ? img.data.slice(prefix.length) : img.data
    if (!clean.length || clean.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || clean.length % 4 !== 0) continue
    const bytes = base64DecodedBytes(clean)
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES || !BASE64_RE.test(clean)) continue
    if (total + bytes > MAX_TOTAL_IMAGE_BYTES) break
    total += bytes
    out.push({ type: 'image', data: clean, mimeType: img.mimeType })
  }
  return out.length ? out : undefined
}

/** A multimodal send must reach the runtime with every selected image. */
export function validatePromptImages(images: unknown): PromptImage[] | undefined | false {
  if (images === undefined || images === null || (Array.isArray(images) && !images.length)) return undefined
  const validated = sanitizeImages(images)
  if (!Array.isArray(images) || !validated || images.length !== validated.length) {
    return false
  }
  return validated
}
