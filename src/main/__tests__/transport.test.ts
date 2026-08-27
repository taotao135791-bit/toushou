import { describe, it, expect } from 'vitest'
import { LineReader, drainLines, serializeCommand, MAX_LINE_BYTES } from '../omp/OmpTransport'

describe('LineReader', () => {
  it('assembles a line split across partial reads', () => {
    const r = new LineReader()
    expect(r.push(Buffer.from('{"a'))).toEqual([])
    expect(r.push(Buffer.from('":1}\n'))).toEqual([{ kind: 'line', line: '{"a":1}' }])
  })

  it('emits several frames from a single chunk', () => {
    const r = new LineReader()
    expect(r.push(Buffer.from('a\nb\nc\n'))).toEqual([
      { kind: 'line', line: 'a' },
      { kind: 'line', line: 'b' },
      { kind: 'line', line: 'c' }
    ])
  })

  it('strips a trailing \\r from CRLF-terminated lines', () => {
    const r = new LineReader()
    expect(r.push(Buffer.from('one\r\ntwo\r\n'))).toEqual([
      { kind: 'line', line: 'one' },
      { kind: 'line', line: 'two' }
    ])
  })

  it('stitches multi-byte characters split across chunks', () => {
    const line = JSON.stringify({ text: '你好，世界 👋' })
    const buf = Buffer.from(line + '\n', 'utf8')
    // Cut one byte into the 3-byte '你' so the first chunk ends mid-character.
    const cutAt = Buffer.byteLength(line.slice(0, line.indexOf('你')), 'utf8') + 1
    const r = new LineReader()
    expect(r.push(buf.subarray(0, cutAt))).toEqual([])
    expect(r.push(buf.subarray(cutAt))).toEqual([{ kind: 'line', line }])
  })

  it('stitches a 4-byte emoji split across chunks', () => {
    const line = '{"emoji":"👋"}'
    const buf = Buffer.from(line + '\n', 'utf8')
    const cutAt = Buffer.byteLength(line.slice(0, line.indexOf('👋')), 'utf8') + 2
    const r = new LineReader()
    expect(r.push(buf.subarray(0, cutAt))).toEqual([])
    expect(r.push(buf.subarray(cutAt))).toEqual([{ kind: 'line', line }])
  })

  it('errors on a line exceeding the byte cap and recovers at the next LF', () => {
    const r = new LineReader()
    const events = r.push(Buffer.alloc(MAX_LINE_BYTES + 1024, 'a'))
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('error')
    expect((events[0] as { message: string }).message).toMatch(/limit/)
    // The rest of the giant line is dropped; framing resyncs at its LF.
    expect(r.push(Buffer.from('still the giant line\n{"ok":1}\n'))).toEqual([
      { kind: 'line', line: '{"ok":1}' }
    ])
  })

  it('keeps accepting lines well under the cap', () => {
    const r = new LineReader()
    const ok = 'x'.repeat(1024)
    expect(r.push(Buffer.from(ok + '\n'))).toEqual([{ kind: 'line', line: ok }])
  })

  it('emits a residual line at EOF (no trailing LF)', () => {
    const r = new LineReader()
    expect(r.push(Buffer.from('{"partial":true'))).toEqual([])
    expect(r.flush()).toEqual([{ kind: 'line', line: '{"partial":true' }])
  })

  it('flush with an empty buffer emits nothing', () => {
    const r = new LineReader()
    r.push(Buffer.from('a\n'))
    expect(r.flush()).toEqual([])
  })

  it('skips blank lines', () => {
    const r = new LineReader()
    expect(r.push(Buffer.from('a\n\n  \nb\n'))).toEqual([
      { kind: 'line', line: 'a' },
      { kind: 'line', line: 'b' }
    ])
  })
})

describe('drainLines', () => {
  it('splits complete lines and keeps the remainder', () => {
    const { lines, rest } = drainLines('', 'a\nb\npart')
    expect(lines).toEqual(['a', 'b'])
    expect(rest).toBe('part')
  })

  it('combines with the previous buffer', () => {
    const { lines, rest } = drainLines('hel', 'lo\nworld\n')
    expect(lines).toEqual(['hello', 'world'])
    expect(rest).toBe('')
  })

  it('skips blank lines', () => {
    const { lines } = drainLines('', 'a\n\n  \nb\n')
    expect(lines).toEqual(['a', 'b'])
  })

  it('handles a chunk with no newline', () => {
    const { lines, rest } = drainLines('x', 'yz')
    expect(lines).toEqual([])
    expect(rest).toBe('xyz')
  })

  it('strips a trailing \\r per line', () => {
    const { lines } = drainLines('', 'one\r\ntwo\n')
    expect(lines).toEqual(['one', 'two'])
  })
})

describe('serializeCommand', () => {
  it('serializes a command as one LF-terminated JSON line', () => {
    expect(serializeCommand({ id: '1', type: 'abort' })).toBe('{"id":"1","type":"abort"}\n')
  })
})
