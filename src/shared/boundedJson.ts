/**
 * Serialize an IPC/loopback result without silently changing its meaning.
 * The first pass is the original JSON. Only oversized payloads receive a
 * bounded projection, and every projection records its path and count.
 */

const DEFAULT_MAX_BYTES = 24_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface TruncationField {
  path: string
  kind: 'string' | 'array' | 'object' | 'depth'
  returnedCount?: number
  knownTotal?: number
  returnedChars?: number
  knownChars?: number
}

interface ProjectionContext { fields: Map<string, TruncationField> }

interface ProjectionLimits {
  rootArray: number
  nestedArray: number
  rootString: number
  nestedString: number
  objectKeys: number
  nestedObjectKeys: number
  maxDepth: number
}

const PROJECTION_ATTEMPTS: ProjectionLimits[] = [
  { rootArray: 30, nestedArray: 20, rootString: 6_000, nestedString: 1_200, objectKeys: 60, nestedObjectKeys: 30, maxDepth: 5 },
  { rootArray: 12, nestedArray: 8, rootString: 2_000, nestedString: 700, objectKeys: 36, nestedObjectKeys: 20, maxDepth: 5 },
  { rootArray: 5, nestedArray: 4, rootString: 800, nestedString: 320, objectKeys: 24, nestedObjectKeys: 14, maxDepth: 4 },
  { rootArray: 1, nestedArray: 1, rootString: 260, nestedString: 180, objectKeys: 12, nestedObjectKeys: 8, maxDepth: 3 },
  { rootArray: 0, nestedArray: 0, rootString: 80, nestedString: 80, objectKeys: 8, nestedObjectKeys: 5, maxDepth: 2 }
]

function pathFor(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`
}

function recordField(context: ProjectionContext, field: TruncationField): void {
  const previous = context.fields.get(field.path)
  context.fields.set(field.path, previous ? { ...previous, ...field } : field)
}

function clipText(value: string, max: number, path: string, context: ProjectionContext): string {
  if (value.length <= max) return value
  const returnedChars = Math.max(0, max - 1)
  recordField(context, { path, kind: 'string', returnedChars, knownChars: value.length })
  return `${value.slice(0, returnedChars)}…`
}

function project(value: unknown, context: ProjectionContext, limits: ProjectionLimits, depth = 0, path = '$'): unknown {
  if (typeof value === 'string') {
    return clipText(value, depth === 0 ? limits.rootString : limits.nestedString, path, context)
  }
  if (typeof value !== 'object' || value === null) return value
  if (depth >= limits.maxDepth) {
    recordField(context, { path, kind: 'depth', returnedCount: 0, knownTotal: 1 })
    return '[truncated]'
  }
  if (Array.isArray(value)) {
    const limit = depth === 0 ? limits.rootArray : limits.nestedArray
    const items = value.slice(0, limit)
    if (items.length < value.length) {
      recordField(context, { path, kind: 'array', returnedCount: items.length, knownTotal: value.length })
    }
    return items.map((item, index) => project(item, context, limits, depth + 1, pathFor(path, index)))
  }
  const entries = Object.entries(value)
  const limit = depth === 0 ? limits.objectKeys : limits.nestedObjectKeys
  if (entries.length > limit) {
    recordField(context, { path, kind: 'object', returnedCount: limit, knownTotal: entries.length })
  }
  return Object.fromEntries(
    entries.slice(0, limit).map(([key, item]) => [key, project(item, context, limits, depth + 1, pathFor(path, key))])
  )
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function stringify(value: unknown): string | null {
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === 'string' ? encoded : null
  } catch {
    return null
  }
}

function buildCandidate(original: Record<string, unknown>, projected: unknown, context: ProjectionContext): Record<string, unknown> {
  const payload = isRecord(projected) ? projected : { ok: true, value: projected }
  const candidate: Record<string, unknown> = {
    ...payload,
    truncated: true,
    truncation: { reason: 'transport-byte-limit', fields: [...context.fields.values()] }
  }
  if (original.verified === true) {
    candidate.verified = false
    candidate.verification = { status: 'partial', reason: 'transport-truncated' }
  }
  return candidate
}

/** Return valid JSON within maxBytes while preserving explicit completeness semantics. */
export function serializeBoundedJson(value: unknown, maxBytes = DEFAULT_MAX_BYTES): string {
  const original = isRecord(value) ? value : { ok: true, value }
  const originalJson = stringify(original)
  if (originalJson && byteLength(originalJson) <= maxBytes) return originalJson

  for (const limits of PROJECTION_ATTEMPTS) {
    const context: ProjectionContext = { fields: new Map() }
    const projected = project(original, context, limits)
    const json = stringify(buildCandidate(original, projected, context))
    if (json && byteLength(json) <= maxBytes) return json
  }

  const fallback: Record<string, unknown> = {
    ok: typeof original.ok === 'boolean' ? original.ok : true,
    truncated: true,
    truncation: { reason: 'transport-byte-limit', fields: [] }
  }
  if (typeof original.error === 'string') fallback.error = original.error.slice(0, 300)
  if (typeof original.url === 'string') fallback.url = original.url.slice(0, 500)
  if (typeof original.title === 'string') fallback.title = original.title.slice(0, 300)
  const fallbackJson = stringify(fallback)
  return fallbackJson && byteLength(fallbackJson) <= maxBytes
    ? fallbackJson
    : JSON.stringify({ ok: false, truncated: true, error: 'result-too-large' })
}
