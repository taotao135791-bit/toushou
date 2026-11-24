export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_COUNT = 4
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif'
})

const supported = new Set(Object.values(IMAGE_MIME_BY_EXT))
export function isPromptImageMime(mimeType: string): boolean {
  return supported.has(mimeType)
}

export function base64DecodedBytes(data: string): number {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length - comma - 1) * 3 / 4) - pad
}
