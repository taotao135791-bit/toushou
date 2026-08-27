import { describe, it, expect } from 'vitest'
import {
  RpcFrameDecoder,
  RpcFrameError,
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  RPC_CHUNK_PAYLOAD_BYTES
} from '../omp/OmpTransport'

/**
 * rpc_chunk reassembly tests. Limits and validation rules mirror the
 * upstream RpcFrameDecoder (omp 17.2.12), cross-checked live against the
 * real binary (docs/protocol-facts.md).
 */

/** Build a valid chunk sequence for a payload, like the upstream encoder. */
function chunkify(value: unknown, chunkId = 'rpc-1', chunkSize = RPC_CHUNK_PAYLOAD_BYTES) {
  const json = JSON.stringify(value)
  const bytes = Buffer.from(json, 'utf8')
  const count = Math.ceil(bytes.length / chunkSize)
  const frames = []
  for (let index = 0; index < count; index++) {
    frames.push({
      type: 'rpc_chunk',
      chunkId,
      index,
      count,
      byteLength: bytes.length,
      data: bytes.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64')
    })
  }
  return frames
}

/** Split a raw buffer into a valid chunk sequence (all chunks ≤ 256 KiB). */
function chunkBuffer(bytes: Buffer, chunkId: string) {
  const count = Math.ceil(bytes.length / RPC_CHUNK_PAYLOAD_BYTES)
  const frames = []
  for (let index = 0; index < count; index++) {
    frames.push({
      type: 'rpc_chunk',
      chunkId,
      index,
      count,
      byteLength: bytes.length,
      data: bytes.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES).toString('base64')
    })
  }
  return frames
}

/** A payload whose JSON exceeds the physical frame limit (chunking only happens there). */
function bigValue(payloadBytes = MAX_RPC_FRAME_BYTES + 4096) {
  return { type: 'response', id: 'x', command: 'get_messages', success: true, data: { text: 'A'.repeat(payloadBytes) } }
}

describe('RpcFrameDecoder', () => {
  it('passes plain objects through untouched', () => {
    const d = new RpcFrameDecoder()
    expect(d.push({ type: 'agent_start' })).toEqual({ type: 'agent_start' })
  })

  it('rejects non-object frames', () => {
    const d = new RpcFrameDecoder()
    expect(() => d.push('hello')).toThrowError(RpcFrameError)
    expect(() => d.push(42)).toThrowError(/must be an object/)
    expect(() => d.push(null)).toThrowError(RpcFrameError)
    expect(() => d.push([1, 2])).toThrowError(RpcFrameError)
  })

  it('reassembles a chunked frame byte-exactly', () => {
    const d = new RpcFrameDecoder()
    const value = bigValue()
    // ~1 MiB of JSON → 4+ chunks of ≤256 KiB (a 2-chunk sequence cannot be
    // valid: byteLength ≥ 1 MiB with a 256 KiB per-chunk cap).
    const chunks = chunkify(value)
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    let out: object | undefined
    for (let i = 0; i < chunks.length; i++) {
      const r = d.push(chunks[i])
      if (i < chunks.length - 1) expect(r).toBeUndefined()
      else out = r
    }
    expect(out).toEqual(value)
    expect(JSON.stringify(out)).toBe(JSON.stringify(value))
  })

  it('reassembles a many-chunk frame byte-exactly', () => {
    const d = new RpcFrameDecoder()
    const value = bigValue(4 * RPC_CHUNK_PAYLOAD_BYTES + 123)
    const chunks = chunkify(value)
    expect(chunks.length).toBeGreaterThanOrEqual(5)
    let out: object | undefined
    for (const c of chunks) out = d.push(c)
    expect(out).toEqual(value)
    expect(JSON.stringify(out)).toBe(JSON.stringify(value))
  })

  it('reassembles multi-byte UTF-8 split across chunk boundaries', () => {
    const d = new RpcFrameDecoder()
    // 4-byte emoji straddling two chunks: cut the payload mid-character by
    // using a tiny custom chunk size. (~2 MB of text, so chunking applies.)
    const value = { type: 'x', text: '你好👋'.repeat(200_000) }
    const chunks = chunkify(value, 'rpc-u', 65_537) // odd size forces mid-char cuts
    let out: object | undefined
    for (const c of chunks) out = d.push(c)
    expect(out).toEqual(value)
  })

  it('rejects an out-of-order index', () => {
    const d = new RpcFrameDecoder()
    const chunks = chunkify(bigValue())
    expect(() => d.push(chunks[1])).toThrowError(/must start at index 0/)
  })

  it('rejects a duplicate chunk', () => {
    const d = new RpcFrameDecoder()
    const chunks = chunkify(bigValue())
    d.push(chunks[0])
    expect(() => d.push(chunks[0])).toThrowError(/sequence mismatch/)
  })

  it('rejects a skipped index', () => {
    const d = new RpcFrameDecoder()
    const chunks = chunkify(bigValue())
    d.push(chunks[0])
    expect(() => d.push(chunks[2])).toThrowError(/sequence mismatch/)
  })

  it('rejects a chunkId change mid-sequence', () => {
    const d = new RpcFrameDecoder()
    const chunks = chunkify(bigValue())
    d.push(chunks[0])
    expect(() => d.push({ ...chunks[1], chunkId: 'rpc-other' })).toThrowError(/sequence mismatch/)
  })

  it('rejects a count change mid-sequence', () => {
    const d = new RpcFrameDecoder()
    const chunks = chunkify(bigValue())
    d.push(chunks[0])
    expect(() => d.push({ ...chunks[1], count: chunks[1].count + 1 })).toThrowError(
      /sequence mismatch/
    )
  })

  it('rejects metadata outside the declared limits', () => {
    const d = new RpcFrameDecoder()
    const base = chunkify(bigValue())[0]
    // count < 2
    expect(() => d.push({ ...base, count: 1 })).toThrowError(/metadata/)
    // byteLength below the physical frame limit (chunking never applies there)
    expect(() => d.push({ ...base, byteLength: MAX_RPC_FRAME_BYTES - 1 })).toThrowError(/metadata/)
    // byteLength above the reassembly ceiling
    expect(() =>
      d.push({ ...base, byteLength: MAX_RPC_REASSEMBLED_BYTES + 1 })
    ).toThrowError(/metadata/)
    // index >= count
    expect(() => d.push({ ...base, index: base.count })).toThrowError(/metadata/)
    // empty / oversized chunkId
    expect(() => d.push({ ...base, chunkId: '' })).toThrowError(/metadata/)
    expect(() => d.push({ ...base, chunkId: 'x'.repeat(129) })).toThrowError(/metadata/)
    // non-integer fields
    expect(() => d.push({ ...base, index: 0.5 })).toThrowError(/metadata/)
  })

  it('rejects invalid base64 payloads', () => {
    const d = new RpcFrameDecoder()
    const base = chunkify(bigValue())[0]
    expect(() => d.push({ ...base, data: '!!!not-base64!!!' })).toThrowError(/chunk data/)
    expect(() => d.push({ ...base, data: '' })).toThrowError(/chunk data/)
    // Round-trip check: decodable but non-canonical padding/whitespace
    expect(() => d.push({ ...base, data: base.data + '\n' })).toThrowError(/chunk data/)
  })

  it('rejects a per-chunk payload over the 256 KiB limit', () => {
    const d = new RpcFrameDecoder()
    const oversized = Buffer.alloc(RPC_CHUNK_PAYLOAD_BYTES + 1, 65).toString('base64')
    expect(() =>
      d.push({
        type: 'rpc_chunk',
        chunkId: 'rpc-1',
        index: 0,
        count: 2,
        byteLength: MAX_RPC_FRAME_BYTES + 1,
        data: oversized
      })
    ).toThrowError(/exceeds the transport limit/)
  })

  it('rejects a sequence exceeding its declared byteLength', () => {
    const d = new RpcFrameDecoder()
    const value = bigValue()
    const chunks = chunkify(value)
    // Lie: declare one byte less than actually sent.
    const lying = chunks.map((c) => ({ ...c, byteLength: Buffer.from(JSON.stringify(value)).length - 1 }))
    let err: unknown
    try {
      for (const c of lying) d.push(c)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(RpcFrameError)
    expect(String(err)).toMatch(/exceeds declared length|length mismatch/)
  })

  it('rejects a non-chunk frame while a sequence is in flight', () => {
    const d = new RpcFrameDecoder()
    const chunks = chunkify(bigValue())
    d.push(chunks[0])
    expect(() => d.push({ type: 'agent_start' })).toThrowError(/interrupted/)
    // The decoder recovers: the next clean frame flows normally.
    expect(d.push({ type: 'agent_start' })).toEqual({ type: 'agent_start' })
  })

  it('rejects reassembled payloads that are not valid JSON objects', () => {
    const d = new RpcFrameDecoder()
    const notJson = Buffer.from('{"unterminated'.repeat(200_000), 'utf8')
    const chunks = chunkBuffer(notJson, 'rpc-bad')
    expect(() => {
      for (const c of chunks) d.push(c)
    }).toThrowError(/not valid JSON/)

    const d2 = new RpcFrameDecoder()
    const scalar = Buffer.from('12345'.repeat(300_000), 'utf8')
    const chunks2 = chunkBuffer(scalar, 'rpc-scalar')
    expect(() => {
      for (const c of chunks2) d2.push(c)
    }).toThrowError(/must be an object/)
  })

  it('rejects invalid UTF-8 in the reassembled payload', () => {
    const d = new RpcFrameDecoder()
    const bad = Buffer.alloc(MAX_RPC_FRAME_BYTES + 10, 0x20)
    bad.write('{"x":"')
    bad[bad.length - 2] = 0xff // invalid UTF-8 bytes inside the string
    bad[bad.length - 1] = 0xfe
    const chunks = chunkBuffer(bad, 'rpc-utf8')
    expect(() => {
      for (const c of chunks) d.push(c)
    }).toThrowError(/UTF-8/)
  })

  it('reset() drops a half-received sequence', () => {
    const d = new RpcFrameDecoder()
    const chunks = chunkify(bigValue())
    d.push(chunks[0])
    d.reset()
    // A new sequence may start at index 0 without an "interrupted" error.
    const again = chunkify(bigValue(), 'rpc-2')
    let out: object | undefined
    for (const c of again) out = d.push(c)
    expect(out).toBeDefined()
  })
})
