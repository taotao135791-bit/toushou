/**
 * Serialize an IPC/loopback result only after bounding its structure.
 *
 * Slicing a JSON string can cut through a quoted CJK/emoji string, an escaped
 * character, or a nested array and leaves the receiver with invalid JSON. The
 * host uses this small deterministic projection instead: data fields are
 * reduced first, then the envelope is serialized exactly once.
 */

const DEFAULT_MAX_BYTES = 24_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clipText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function project(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return clipText(value, depth === 0 ? 6_000 : 1_200)
  if (typeof value !== 'object' || value === null) return value
  if (depth >= 5) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, depth === 0 ? 30 : 20).map((item) => project(item, depth + 1))
  const entries = Object.entries(value).slice(0, depth === 0 ? 60 : 30)
  return Object.fromEntries(entries.map(([key, item]) => [key, project(item, depth + 1)]))
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Return valid JSON within `maxBytes` whenever possible. `ok` and `error` are
 * retained in the last-resort envelope so a truncated successful result is
 * still distinguishable from an action failure.
 */
export function serializeBoundedJson(value: unknown, maxBytes = DEFAULT_MAX_BYTES): string {
  const original = isRecord(value) ? value : { ok: true, value }
  const projected = project(original)
  let candidate: Record<string, unknown> = isRecord(projected) ? projected : { ok: true, value: projected }
  const originalArrays = Object.entries(original).filter(([, item]) => Array.isArray(item))
  let json = JSON.stringify(candidate)
  if (byteLength(json) <= maxBytes) return json

  candidate = {
    ...candidate,
    truncated: true,
    truncation: {
      reason: 'transport-byte-limit',
      arrays: originalArrays.map(([key, item]) => ({
        field: key,
        returnedCount: Array.isArray(candidate[key]) ? candidate[key].length : 0,
        knownTotal: Array.isArray(item) ? item.length : undefined
      }))
    }
  }
  json = JSON.stringify(candidate)
  if (byteLength(json) <= maxBytes) return json

  // Progressively reduce optional payloads while keeping the result envelope.
  for (const arrayLimit of [10, 5, 1, 0]) {
    const reduced: Record<string, unknown> = { ...candidate }
    for (const [key, item] of Object.entries(reduced)) {
      if (Array.isArray(item)) reduced[key] = item.slice(0, arrayLimit)
      if (typeof item === 'string' && key !== 'error') reduced[key] = clipText(item, arrayLimit === 0 ? 0 : 1_000)
    }
    json = JSON.stringify(reduced)
    if (byteLength(json) <= maxBytes) return json
  }

  const fallback: Record<string, unknown> = {
    ok: typeof original.ok === 'boolean' ? original.ok : true,
    truncated: true,
    truncation: { reason: 'transport-byte-limit' }
  }
  if (typeof original.error === 'string') fallback.error = clipText(original.error, 300)
  if (typeof original.url === 'string') fallback.url = clipText(original.url, 500)
  if (typeof original.title === 'string') fallback.title = clipText(original.title, 300)
  json = JSON.stringify(fallback)
  return byteLength(json) <= maxBytes ? json : JSON.stringify({ ok: false, truncated: true, error: 'result-too-large' })
}
