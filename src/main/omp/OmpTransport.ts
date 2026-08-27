import { StringDecoder } from 'node:string_decoder'

/**
 * Transport layer for pi/omp `--mode rpc`, two levels deep:
 *
 * Physical level — strict LF-only JSONL over stdio, one line == one JSON
 * object, both directions (LineReader / serializeCommand). Reader guarantees
 * (mirroring pi's own jsonl.js, verified against the installed 0.80.3 and
 * omp 17.2.12 — see docs/protocol-facts.md):
 * - StringDecoder stitching, so multi-byte UTF-8 characters split across
 *   stream chunks never corrupt a line;
 * - partial reads: an arbitrary byte split only delays a line;
 * - several frames in one chunk are all surfaced;
 * - a trailing `\r` is stripped from each line.
 *
 * Logical level — protocol v2 `rpc_chunk` reassembly (RpcFrameDecoder),
 * verified byte-exact against omp 17.2.12. A logical frame whose JSON
 * exceeds the physical 1 MiB ceiling arrives as a sequence of chunk frames
 * carrying base64 payload slices; the decoder validates and reassembles
 * them. Validation mirrors the upstream RpcFrameDecoder exactly.
 *
 * Safety valves absent from pi itself: a single physical line may not exceed
 * MAX_LINE_BYTES, and reassembly is bounded by MAX_RPC_REASSEMBLED_BYTES.
 * Violations produce transport-level errors instead of growing memory
 * without bound or crashing the host.
 *
 * Outgoing commands are always single physical lines: the omp stdin reader
 * imposes no frame-size limit on input (verified live with a 2 MiB command),
 * so client-side chunking is unnecessary.
 *
 * Pure Node — no Electron imports — so it is unit-testable in isolation.
 */

/** Maximum accepted size of one JSONL frame, in bytes (16 MB). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024

/** Protocol v2 limits, advertised by the runtime's `ready` frame. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024
/** Raw payload bytes per rpc_chunk frame (base64-encoded on the wire). */
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024

export type TransportEvent =
  | { kind: 'line'; line: string }
  /** Transport-level problem (e.g. oversize line); the stream stays open. */
  | { kind: 'error'; message: string }

/**
 * Incremental Buffer → JSONL lines reader. Feed stdout chunks to `push()`,
 * call `flush()` at EOF to surface a trailing line without a final LF.
 */
export class LineReader {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  /** Byte length of `buffer` (tracked incrementally; byteLength is O(n)). */
  private pendingBytes = 0
  /** Dropping the remainder of an oversize line until its LF arrives. */
  private dropping = false

  push(chunk: Buffer): TransportEvent[] {
    const events: TransportEvent[] = []
    let text = this.decoder.write(chunk)

    if (this.dropping) {
      const idx = text.indexOf('\n')
      if (idx === -1) return events // still inside the oversize line
      text = text.slice(idx + 1)
      this.dropping = false
      this.buffer = ''
      this.pendingBytes = 0
    }

    this.pendingBytes += chunk.length
    const combined = this.buffer + text
    const parts = combined.split('\n')
    this.buffer = parts.pop() ?? ''
    if (parts.length > 0) {
      // Complete lines were consumed; the exact byte count of the short
      // remainder is cheap to recompute and keeps `pendingBytes` honest.
      this.pendingBytes = Buffer.byteLength(this.buffer, 'utf8')
      for (const part of parts) {
        const line = part.endsWith('\r') ? part.slice(0, -1) : part
        if (line.trim().length > 0) events.push({ kind: 'line', line })
      }
    }

    if (this.pendingBytes > MAX_LINE_BYTES) {
      events.push({
        kind: 'error',
        message: `RPC line exceeded the ${MAX_LINE_BYTES}-byte limit; dropping it`
      })
      this.buffer = ''
      this.pendingBytes = 0
      this.dropping = true
    }
    return events
  }

  /** EOF: emit a residual line that never got its terminating LF. */
  flush(): TransportEvent[] {
    const tail = this.decoder.end()
    const events: TransportEvent[] = []
    if (!this.dropping) {
      let rest = this.buffer + tail
      if (rest.endsWith('\r')) rest = rest.slice(0, -1)
      if (rest.trim().length > 0) events.push({ kind: 'line', line: rest })
    }
    this.buffer = ''
    this.pendingBytes = 0
    this.dropping = false
    return events
  }
}

/**
 * Split a stream chunk into complete lines, keeping the remainder in
 * `buffer`. Strips a trailing `\r` per line and skips blank lines.
 * String-level helper — prefer LineReader for Buffer streams.
 */
export function drainLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk
  const parts = combined.split('\n')
  const rest = parts.pop() || ''
  const lines: string[] = []
  for (const part of parts) {
    const line = part.endsWith('\r') ? part.slice(0, -1) : part
    if (line.trim().length > 0) lines.push(line)
  }
  return { lines, rest }
}

/** Serialize a command object into one LF-terminated JSONL frame for stdin. */
export function serializeCommand(command: Record<string, unknown>): string {
  return JSON.stringify(command) + '\n'
}

// ---------------------------------------------------------------------------
// Protocol v2 logical frames: rpc_chunk reassembly
// ---------------------------------------------------------------------------

/** A transport-level framing violation; `code` is machine-readable. */
export class RpcFrameError extends Error {
  constructor(
    readonly code:
      | 'chunk_interrupted'
      | 'not_object'
      | 'chunk_metadata'
      | 'chunk_data'
      | 'chunk_payload_size'
      | 'chunk_sequence'
      | 'chunk_length'
      | 'chunk_utf8'
      | 'chunk_json',
    message: string
  ) {
    super(message)
    this.name = 'RpcFrameError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strict base64: alphabet/padding shape plus a decode→encode round-trip. */
function decodeChunkData(data: unknown): Buffer {
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw new RpcFrameError('chunk_data', 'invalid rpc chunk data')
  }
  const buf = Buffer.from(data, 'base64')
  if (buf.toString('base64') !== data) {
    throw new RpcFrameError('chunk_data', 'invalid rpc chunk data')
  }
  return buf
}

interface PendingChunks {
  chunkId: string
  count: number
  byteLength: number
  nextIndex: number
  chunks: Buffer[]
  receivedBytes: number
}

/**
 * Reassemble protocol v2 `rpc_chunk` sequences into logical frames. Feed
 * every parsed JSONL object to `push()`; it returns the complete logical
 * frame, or undefined while a chunk sequence is in flight.
 *
 * Validation mirrors the upstream RpcFrameDecoder (omp 17.2.12), including
 * its limits: chunkId 1–128 chars; count ∈ [2, 256]; declared byteLength ∈
 * [1 MiB, 64 MiB]; per-chunk payload ≤ 256 KiB; strict base64; contiguous
 * indices from 0 with a consistent chunkId/count/byteLength; received bytes
 * must equal the declared length exactly; the reassembled buffer must be
 * fatal-UTF-8 JSON of an object. Any violation throws RpcFrameError and the
 * partial sequence is dropped — the next sequence starts clean.
 */
export class RpcFrameDecoder {
  private pending: PendingChunks | undefined

  /** Drop a half-received sequence (e.g. after EOF or a transport error). */
  reset(): void {
    this.pending = undefined
  }

  push(value: unknown): object | undefined {
    if (!isPlainObject(value) || value.type !== 'rpc_chunk') {
      if (this.pending) {
        this.pending = undefined
        throw new RpcFrameError('chunk_interrupted', 'rpc chunk sequence interrupted')
      }
      if (!isPlainObject(value)) {
        throw new RpcFrameError('not_object', 'rpc frame must be an object')
      }
      return value
    }

    try {
      return this.pushChunk(value)
    } catch (err) {
      // A malformed sequence must not wedge the decoder: drop all state so
      // the next frame (chunk or not) starts from a clean slate.
      this.pending = undefined
      throw err
    }
  }

  private pushChunk(frame: Record<string, unknown>): object | undefined {
    const { chunkId, index, count, byteLength } = frame as {
      chunkId?: unknown
      index?: unknown
      count?: unknown
      byteLength?: unknown
    }
    const maxCount = Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES)
    if (
      typeof chunkId !== 'string' ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      (index as number) < 0 ||
      (count as number) < 2 ||
      (count as number) > maxCount ||
      (index as number) >= (count as number) ||
      (byteLength as number) < MAX_RPC_FRAME_BYTES ||
      (byteLength as number) > MAX_RPC_REASSEMBLED_BYTES
    ) {
      throw new RpcFrameError('chunk_metadata', 'invalid rpc chunk metadata')
    }
    const payload = decodeChunkData(frame.data)
    if (payload.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new RpcFrameError('chunk_payload_size', 'rpc chunk payload exceeds the transport limit')
    }

    if (!this.pending) {
      if (index !== 0) {
        throw new RpcFrameError('chunk_sequence', 'rpc chunk sequence must start at index 0')
      }
      this.pending = {
        chunkId,
        count: count as number,
        byteLength: byteLength as number,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0
      }
    }
    const seq = this.pending
    if (
      seq.chunkId !== chunkId ||
      seq.count !== count ||
      seq.byteLength !== byteLength ||
      seq.nextIndex !== index
    ) {
      throw new RpcFrameError('chunk_sequence', 'rpc chunk sequence mismatch')
    }
    seq.chunks.push(payload)
    seq.receivedBytes += payload.byteLength
    seq.nextIndex++
    if (seq.receivedBytes > seq.byteLength) {
      throw new RpcFrameError('chunk_length', 'rpc chunk sequence exceeds declared length')
    }
    if (seq.nextIndex < seq.count) return undefined
    if (seq.receivedBytes !== seq.byteLength) {
      throw new RpcFrameError('chunk_length', 'rpc chunk sequence length mismatch')
    }
    this.pending = undefined

    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(seq.chunks))
    } catch {
      throw new RpcFrameError('chunk_utf8', 'rpc chunk payload is not valid UTF-8')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new RpcFrameError('chunk_json', 'rpc chunk payload is not valid JSON')
    }
    if (!isPlainObject(parsed)) {
      throw new RpcFrameError('not_object', 'rpc frame must be an object')
    }
    return parsed
  }
}

/**
 * Bounded text capture for a noisy stream (ring buffer, default 10 KB).
 * Used for session stderr: the CLI writes progress/diagnostic noise there,
 * so it is never streamed to the chat; only the tail is surfaced when the
 * process dies abnormally. (Re-exported by OmpProcess, its owner.)
 */
export class StderrRing {
  private buffer = ''

  constructor(private readonly maxChars = 10_000) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    if (this.buffer.length > this.maxChars) {
      this.buffer = this.buffer.slice(-this.maxChars)
    }
  }

  /** Last `maxLines` lines of the captured output ('' when empty). */
  tail(maxLines = 3): string {
    return this.buffer.trim().split('\n').slice(-maxLines).join('\n')
  }
}
