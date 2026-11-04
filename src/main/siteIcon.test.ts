import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { deflateSync } from 'node:zlib'
import type { RequestOptions } from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSiteIconService, isPublicIPv4, requestSiteIcon, validRaster, validSiteHostname } from './siteIcon'

function chunk(type: string, body = Buffer.alloc(0)) {
  const out = Buffer.alloc(body.length + 12)
  out.writeUInt32BE(body.length, 0); out.write(type, 4, 4, 'ascii'); body.copy(out, 8)
  let crc = 0xffffffff
  for (const byte of out.subarray(4, out.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4)
  return out
}
function png(width = 32, height = 32, animated = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  // Real scanlines for ordinary fixtures; huge dimensions exercise header rejection without allocating them.
  const scanlines = Buffer.alloc(width <= 512 && height <= 512 ? (width * 4 + 1) * height : 1)
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...(animated ? [chunk('acTL', Buffer.alloc(8))] : []), chunk('IDAT', deflateSync(scanlines)), chunk('IEND')])
}
function dib() {
  const value = Buffer.alloc(40 + 32 * 32 * 4 + 32 * 4)
  value.writeUInt32LE(40, 0); value.writeInt32LE(32, 4); value.writeInt32LE(64, 8)
  value.writeUInt16LE(1, 12); value.writeUInt16LE(32, 14)
  return value
}
function ico(image = png()) {
  const result = Buffer.alloc(22 + image.length)
  result.writeUInt16LE(1, 2); result.writeUInt16LE(1, 4); result[6] = 32; result[7] = 32
  result.writeUInt32LE(image.length, 14); result.writeUInt32LE(22, 18); image.copy(result, 22)
  return result
}
const goodImage = { bytes: png(), mime: 'image/png' }
const pngUrl = `data:image/png;base64,${goodImage.bytes.toString('base64')}`
const publicAnswer = [{ address: '8.8.8.8', family: 4 }]
afterEach(() => { vi.useRealTimers() })

describe('site icon request boundaries', () => {
  it('accepts only public-looking hostnames and rejects special-use IPs', () => {
    expect(validSiteHostname('WWW.Public.COM')).toBe('www.public.com')
    for (const value of ['https://public.com', 'public.com/?q=x', '127.0.0.1', '::1', 'localhost', 'a.local', 'a.internal', 'name.test', 'example.com', 'sub.example.org', 'user@host.com', 'host.com:443', 'bad..com', 'bad-.com', 'host.com.']) expect(validSiteHostname(value)).toBeNull()
    for (const ip of ['0.1.2.3', '10.1.2.3', '100.64.1.1', '127.0.0.1', '169.254.169.254', '172.31.1.2', '192.168.1.2', '192.0.2.3', '198.18.1.2', '198.51.100.2', '203.0.113.2', '224.1.2.3', '255.255.255.255', '::ffff:127.0.0.1']) expect(isPublicIPv4(ip), ip).toBe(false)
    expect(isPublicIPv4('8.8.8.8')).toBe(true)
  })
  it('rejects dangerous types, oversized data, and dimensions before renderer decode', () => {
    expect(validRaster(png(), 'image/png')).toBe(true)
    expect(validRaster(ico(), 'image/x-icon')).toBe(true)
    expect(validRaster(png(4096, 4096), 'image/png')).toBe(false)
    expect(validRaster(ico(png(512, 512)), 'image/x-icon')).toBe(false)
    expect(validRaster(Buffer.from('<svg/>'), 'image/svg+xml')).toBe(false)
    expect(validRaster(Buffer.alloc(256 * 1024 + 1), 'image/png')).toBe(false)
    expect(validRaster(ico().subarray(0, 25), 'image/x-icon')).toBe(false)
  })
  it('bounds PNG chunks and rejects animations, including PNG embedded inside ICO', () => {
    const valid = png()
    const brokenLength = Buffer.from(valid); brokenLength.writeUInt32BE(0xffffffff, 8)
    const noEnd = valid.subarray(0, valid.length - 12)
    const extra = Buffer.concat([valid, Buffer.from([0])])
    for (const value of [brokenLength, noEnd, extra, png(32, 32, true)]) expect(validRaster(value, 'image/png')).toBe(false)
    expect(validRaster(ico(png(32, 32, true)), 'image/x-icon')).toBe(false)
    expect(validRaster(ico(dib()), 'image/x-icon')).toBe(true)
    expect(validRaster(valid, 'image/x-icon')).toBe(false)
    expect(validRaster(ico(dib()), 'image/png')).toBe(false)
  })
  it('returns only the verified image bytes with the matching fixed data URL type', async () => {
    for (const [bytes, mime, expected] of [[png(), 'image/png', 'image/png'], [ico(dib()), 'image/vnd.microsoft.icon', 'image/x-icon'], [ico(png()), 'image/x-icon', 'image/x-icon']] as const) {
      const service = createSiteIconService({ lookup: async () => publicAnswer, request: async () => ({ bytes, mime }) })
      const result = await service.get('safe.com')
      expect(result).toEqual({ ok: true, dataUrl: `data:${expected};base64,${bytes.toString('base64')}` })
      if (result.ok) expect(result.dataUrl.length).toBeLessThanOrEqual(Math.ceil(256 * 1024 / 3) * 4 + 32)
    }
  })
  it('blocks any mixed public/private DNS result and passes only a validated address to the request', async () => {
    const request = vi.fn(async (_host: string, _address: string, _signal: AbortSignal) => goodImage)
    const mixed = createSiteIconService({ lookup: async () => [...publicAnswer, { address: '10.0.0.2', family: 4 }], request })
    expect(await mixed.get('safe.com')).toEqual({ ok: false })
    expect(request).not.toHaveBeenCalled()
    const service = createSiteIconService({ lookup: async () => publicAnswer, request })
    expect(await service.get('safe.com')).toEqual({ ok: true, dataUrl: pngUrl })
    expect(request.mock.calls[0][0]).toBe('safe.com')
    expect(request.mock.calls[0][1]).toBe('8.8.8.8')
  })
  it('pins the validated IP, sends no credentials, and rejects redirects and excessive responses', async () => {
    let options: RequestOptions | undefined
    const fakeRequest = (status: number, headers: Record<string, string>, chunks: Buffer[]) => ((requestOptions: RequestOptions, callback: (response: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
      options = requestOptions
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () => {
        const response = Object.assign(new PassThrough(), { statusCode: status, headers })
        callback(response)
        queueMicrotask(() => { for (const chunk of chunks) response.write(chunk); response.end() })
      }
      return req
    }) as unknown as typeof import('node:https').request
    const controller = new AbortController()
    expect(await requestSiteIcon('safe.com', '8.8.8.8', controller.signal, fakeRequest(200, { 'content-type': 'image/png' }, [png()]))).toEqual(goodImage)
    expect(options).toMatchObject({ hostname: 'safe.com', path: '/favicon.ico', servername: 'safe.com', rejectUnauthorized: true, agent: false, family: 4 })
    expect(options?.headers).toEqual({ Accept: 'image/png, image/x-icon, image/vnd.microsoft.icon', 'Accept-Encoding': 'identity' })
    const lookup = options!.lookup as unknown as (host: string, opts: object, cb: (err: null, address: string, family: number) => void) => void
    lookup('safe.com', {}, (_err, address, family) => { expect(address).toBe('8.8.8.8'); expect(family).toBe(4) })
    await expect(requestSiteIcon('safe.com', '8.8.8.8', controller.signal, fakeRequest(302, { location: 'http://127.0.0.1/' }, []))).rejects.toThrow()
    await expect(requestSiteIcon('safe.com', '8.8.8.8', controller.signal, fakeRequest(200, { 'content-type': 'image/png' }, [Buffer.alloc(256 * 1024 + 1)]))).rejects.toThrow()
    await expect(requestSiteIcon('safe.com', '8.8.8.8', controller.signal, fakeRequest(200, { 'content-type': 'text/html' }, [png()]))).rejects.toThrow()
  })
  it('deduplicates, bounds concurrency/queue, and expires success and failure cache entries', async () => {
    let time = 0
    const lookup = vi.fn(async () => publicAnswer)
    const request = vi.fn(async (_host: string, _address: string, _signal: AbortSignal) => goodImage)
    const service = createSiteIconService({ lookup, request, now: () => time })
    const [a, b] = await Promise.all([service.get('safe.com'), service.get('safe.com')])
    expect(a).toEqual(b); expect(lookup).toHaveBeenCalledTimes(1)
    await service.get('safe.com'); expect(lookup).toHaveBeenCalledTimes(1)
    time = 6 * 60 * 60_000 + 1; await service.get('safe.com'); expect(lookup).toHaveBeenCalledTimes(2)
    const failedLookup = vi.fn(async () => { throw new Error('synthetic') })
    const failed = createSiteIconService({ lookup: failedLookup, now: () => time })
    await failed.get('safe.com'); await failed.get('safe.com'); expect(failedLookup).toHaveBeenCalledTimes(1)
    time += 5 * 60_000 + 1; await failed.get('safe.com'); expect(failedLookup).toHaveBeenCalledTimes(2)
    let release!: (value: typeof publicAnswer) => void
    const held = new Promise<typeof publicAnswer>(resolve => { release = resolve })
    const boundedLookup = vi.fn(() => held)
    const bounded = createSiteIconService({ lookup: boundedLookup, request, concurrency: 2, queueLimit: 1 })
    const pending = [bounded.get('one.com'), bounded.get('two.com'), bounded.get('three.com')]
    expect(await bounded.get('four.com')).toEqual({ ok: false })
    expect(boundedLookup).toHaveBeenCalledTimes(2)
    release(publicAnswer); await Promise.all(pending)
    expect(boundedLookup).toHaveBeenCalledTimes(3)
  })
  it('evicts the oldest cached hostname once the 128-entry bound is reached', async () => {
    const lookup = vi.fn(async () => publicAnswer)
    const service = createSiteIconService({ lookup, request: async () => goodImage })
    for (let i = 0; i < 129; i++) expect((await service.get(`site${i}.com`)).ok).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(129)
    await service.get('site0.com')
    expect(lookup).toHaveBeenCalledTimes(130)
  })
  it('rejects invalid rasters and aborts a pending request at the deadline', async () => {
    vi.useFakeTimers()
    const invalid = createSiteIconService({ lookup: async () => publicAnswer, request: async () => ({ bytes: png(4096, 4096), mime: 'image/png' }), fallback: async () => null })
    expect(await invalid.get('safe.com')).toEqual({ ok: false })
    let captured: AbortSignal | undefined
    const stalled = createSiteIconService({ lookup: async () => publicAnswer, request: async (_host, _address, signal) => { captured = signal; return new Promise(() => {}) }, deadlineMs: 3000 })
    const result = stalled.get('other.com')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await result).toEqual({ ok: false })
    expect(captured?.aborted).toBe(true)
  })
  it('returns within the deadline during a stalled DNS lookup without starting a request', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async (_host: string, _address: string, _signal: AbortSignal) => goodImage)
    const service = createSiteIconService({ lookup: () => new Promise(() => {}), request, deadlineMs: 3000 })
    const result = service.get('safe.com')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await result).toEqual({ ok: false })
    expect(request).not.toHaveBeenCalled()
  })
  it('uses only the fixed fallback for fake-IP proxy answers and still validates its raster', async () => {
    const request = vi.fn(async () => goodImage)
    const fallback = vi.fn(async () => goodImage)
    const service = createSiteIconService({ lookup: async () => [{ address: '198.18.1.58', family: 4 }], request, fallback })
    expect(await service.get('github.com')).toEqual({ ok: true, dataUrl: pngUrl })
    expect(request).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledWith('github.com', expect.any(AbortSignal))
    const invalid = createSiteIconService({ lookup: async () => [{ address: '198.18.1.58', family: 4 }], fallback: async () => ({ bytes: Buffer.from('<svg/>'), mime: 'image/svg+xml' }) })
    expect(await invalid.get('github.com')).toEqual({ ok: false })
  })
  it('does not disclose private or mixed-internal DNS names to the fallback', async () => {
    const fallback = vi.fn(async () => goodImage)
    for (const addresses of [[{ address: '10.0.0.1', family: 4 }], [...publicAnswer, { address: '127.0.0.1', family: 4 }], [{ address: '198.18.1.58', family: 4 }, { address: '192.168.1.1', family: 4 }]]) {
      const service = createSiteIconService({ lookup: async () => addresses, fallback })
      expect(await service.get('corporate.com')).toEqual({ ok: false })
    }
    expect(fallback).not.toHaveBeenCalled()
  })
  it('tries the public fallback after a failed pinned origin request', async () => {
    const fallback = vi.fn(async () => goodImage)
    const service = createSiteIconService({ lookup: async () => publicAnswer, request: async () => { throw new Error('synthetic origin unavailable') }, fallback })
    expect(await service.get('github.com')).toEqual({ ok: true, dataUrl: pngUrl })
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})
