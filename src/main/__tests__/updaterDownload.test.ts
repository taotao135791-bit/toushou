import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const updaterMocks = vi.hoisted(() => ({ temp: '', version: '2.2.2', fetch: vi.fn(), proxy: vi.fn(), direct: vi.fn(), fallback: vi.fn(), spawn: vi.fn(), quit: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '2.2.1', getPath: () => updaterMocks.temp, quit: updaterMocks.quit }, BrowserWindow: { getAllWindows: () => [] }, shell: {} }))
vi.mock('electron-updater', () => ({ autoUpdater: { downloadUpdate: updaterMocks.fallback } }))
vi.mock('../integrations/tiktok/proxyFetch', () => ({ proxyFetchFor: updaterMocks.proxy }))
vi.mock('node:https', () => ({ default: { get: updaterMocks.direct } }))
vi.mock('node:child_process', () => ({ spawn: updaterMocks.spawn, spawnSync: vi.fn(), execFile: vi.fn() }))

import { downloadResumable, verifySha512File, type WinFetcher } from '../updater'

/**
 * A tiny HTTP server that answers Range requests with the requested slice of
 * `payload`, can be told to stall (never answer), to ignore Range (200), or
 * to hang up mid-transfer after `dropAfter` bytes.
 */
function startServer(payload: Buffer, options: { stall?: boolean; ignoreRange?: boolean; dropAfter?: number; dropFirst?: boolean; stallFirst?: boolean } = {}): Promise<{ url: string; requests: string[]; close: () => void }> {
  const requests: string[] = []
  let firstRequest = true
  const server = http.createServer((req, res) => {
    requests.push(req.headers.range ?? 'no-range')
    const isFirst = firstRequest
    firstRequest = false
    if (options.stallFirst && isFirst) return // hang the first request only
    if (options.stall) return // hang forever; the watchdog aborts client-side
    if (options.dropFirst && isFirst) {
      // Drop the first connection after a 6-byte prefix, then serve fully.
      res.writeHead(200, { 'content-length': payload.length })
      res.write(payload.subarray(0, 6))
      setTimeout(() => res.destroy(), 10)
      return
    }
    const range = options.ignoreRange ? null : req.headers.range
    if (range) {
      const match = /bytes=(\d+)-/.exec(range)
      const start = match ? Number(match[1]) : 0
      if (start >= payload.length) { res.writeHead(416); res.end(); return }
      const slice = payload.subarray(start)
      if (options.dropAfter && slice.length > options.dropAfter) {
        // A real hangup: declared the full slice, delivered a prefix, then
        // destroyed the connection without a clean end.
        res.writeHead(206, { 'content-length': slice.length, 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` })
        res.write(slice.subarray(0, options.dropAfter))
        setTimeout(() => res.destroy(), 10)
        return
      }
      res.writeHead(206, { 'content-length': slice.length, 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` })
      res.end(slice)
      return
    }
    if (options.dropAfter && payload.length > options.dropAfter) {
      res.writeHead(200, { 'content-length': payload.length })
      res.write(payload.subarray(0, options.dropAfter))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.writeHead(200, { 'content-length': payload.length })
    res.end(payload)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${address.port}/app.exe`, requests, close: () => server.close() })
    })
  })
}

describe('downloadResumable', () => {
  it('downloads a full file in one pass', async () => {
    const payload = Buffer.from('hello updater world')
    const server = await startServer(payload)
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'upd-')), 'app.exe')
    try {
      const fetcher: WinFetcher = async (url, init) => {
        void init
        const response = await fetch(url)
        return { ok: response.ok, status: response.status, headers: { get: (n) => response.headers.get(n) }, body: response.body }
      }
      await downloadResumable(server.url, dest, { fetcher })
      expect(readFileSync(dest, 'utf8')).toBe('hello updater world')
    } finally {
      server.close()
      rmSync(path.dirname(dest), { recursive: true, force: true })
    }
  })

  it('resumes from the partial file after a mid-transfer hangup', async () => {
    const payload = Buffer.from('AAAA BBBB CCCC DDDD')
    // ONE network: the route drops the first connection, then serves fully —
    // the retry resumes over the SAME network from the partial file.
    const server = await startServer(payload, { dropAfter: 6, dropFirst: true })
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'upd-')), 'app.exe')
    try {
      const fetcher: WinFetcher = async (url, init) => {
        const response = await fetch(url, { headers: init.headers })
        return { ok: response.ok, status: response.status, headers: { get: (n) => response.headers.get(n) }, body: response.body }
      }
      await downloadResumable(server.url, dest, { fetcher, sleep: async () => {} })
      expect(readFileSync(dest, 'utf8')).toBe('AAAA BBBB CCCC DDDD')
      // The resume attempt used a Range header starting at the partial size.
      expect(server.requests.filter((r) => r === 'bytes=6-')).toHaveLength(1)
    } finally {
      server.close()
      rmSync(path.dirname(dest), { recursive: true, force: true })
    }
  })

  it('aborts a stalled attempt and retries the same network with resume', async () => {
    const payload = Buffer.from('stall retry payload')
    // ONE network: the first request hangs (route hiccup), later requests serve.
    const server = await startServer(payload, { stallFirst: true })
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'upd-')), 'app.exe')
    try {
      let calls = 0
      const fetcher: WinFetcher = async (_url, init) => {
        calls++
        if (calls === 1) return new Promise<never>(() => {})
        const response = await fetch(server.url, { signal: init.signal, headers: init.headers })
        return { ok: response.ok, status: response.status, headers: { get: (n) => response.headers.get(n) }, body: response.body }
      }
      // Attempt 0 stalls; the watchdog aborts it and the retry (same network,
      // Range resume) completes. No route or node switching happens.
      await downloadResumable(server.url, dest, { fetcher, sleep: async () => {}, stallTimeoutMs: 200 })
      expect(readFileSync(dest, 'utf8')).toBe('stall retry payload')
    } finally {
      server.close()
      rmSync(path.dirname(dest), { recursive: true, force: true })
    }
  })

  it('discards the partial file when the server ignores Range', async () => {
    const payload = Buffer.from('no range support here')
    const partial = 'partial data from a previous attempt'
    const server = await startServer(payload, { ignoreRange: true })
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'upd-')), 'app.exe')
    writeFileSync(dest, partial)
    try {
      const fetcher: WinFetcher = async (url, init) => {
        const response = await fetch(url, { headers: init.headers })
        return { ok: response.ok, status: response.status, headers: { get: (n) => response.headers.get(n) }, body: response.body }
      }
      // Range resume would corrupt: the server answers 200 (ignored), so the
      // downloader must restart from byte 0.
      await downloadResumable(server.url, dest, { fetcher })
      expect(readFileSync(dest, 'utf8')).toBe('no range support here')
      expect(statSync(dest).size).toBe(payload.length)
    } finally {
      server.close()
      rmSync(path.dirname(dest), { recursive: true, force: true })
    }
  })

  it('fails after exhausting retries on a permanently stalled network', async () => {
    const server = await startServer(Buffer.from('x'), { stall: true })
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'upd-')), 'app.exe')
    try {
      const stalledFetcher: WinFetcher = async () => new Promise(() => {})
      await expect(downloadResumable(server.url, dest, { fetcher: stalledFetcher, sleep: async () => {}, stallTimeoutMs: 200 })).rejects.toThrow()
    } finally {
      server.close()
      rmSync(path.dirname(dest), { recursive: true, force: true })
    }
  })

  it('continues clean capped 206 responses until the whole Content-Range total is present', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'upd-')), dest = path.join(dir, 'app.exe')
    writeFileSync(dest, 'AAAA')
    const requests: string[] = []
    try {
      await downloadResumable('https://synthetic.invalid/app.exe', dest, { totalSize: 12, fetcher: async (_url, init) => {
        requests.push(init.headers?.Range ?? '')
        const start = requests.length === 1 ? 4 : 8
        return { ok: true, status: 206, headers: new Headers({ 'content-length': '4', 'content-range': `bytes ${start}-${start + 3}/12` }), body: new Response(start === 4 ? 'BBBB' : 'CCCC').body }
      } })
      expect(readFileSync(dest, 'utf8')).toBe('AAAABBBBCCCC')
      expect(requests).toEqual(['bytes=4-', 'bytes=8-'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects a mismatched 206 start without appending it to the partial file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'upd-')), dest = path.join(dir, 'app.exe')
    writeFileSync(dest, 'AAAA')
    try {
      await expect(downloadResumable('https://synthetic.invalid/app.exe', dest, { sleep: async () => {}, fetcher: async () => ({ ok: true, status: 206, headers: new Headers({ 'content-length': '4', 'content-range': 'bytes 0-3/12' }), body: new Response('BBBB').body }) })).rejects.toThrow('范围不匹配')
      expect(readFileSync(dest, 'utf8')).toBe('AAAA')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('restarts an oversized stale partial after 416 instead of declaring it complete', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'upd-')), dest = path.join(dir, 'app.exe')
    writeFileSync(dest, 'stale-longer-file')
    const requests: Array<string | undefined> = []
    try {
      await downloadResumable('https://synthetic.invalid/app.exe', dest, { totalSize: 3, sleep: async () => {}, fetcher: async (_url, init) => {
        requests.push(init.headers?.Range)
        return requests.length === 1
          ? { ok: false, status: 416, headers: new Headers({ 'content-range': 'bytes */3' }), body: new Response('').body }
          : { ok: true, status: 200, headers: new Headers({ 'content-length': '3' }), body: new Response('new').body }
      } })
      expect(readFileSync(dest, 'utf8')).toBe('new')
      expect(requests).toEqual(['bytes=17-', undefined])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('cancels a stalled body before another writer resumes the file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'upd-')), dest = path.join(dir, 'app.exe')
    const cancelled = vi.fn()
    let firstController!: ReadableStreamDefaultController<Uint8Array>, calls = 0
    try {
      await downloadResumable('https://synthetic.invalid/app.exe', dest, { totalSize: 3, stallTimeoutMs: 50, sleep: async () => {}, fetcher: async (_url, init) => {
        if (++calls === 1) return { ok: true, status: 200, headers: new Headers({ 'content-length': '3' }), body: new ReadableStream<Uint8Array>({ start(controller) { firstController = controller; controller.enqueue(Buffer.from('A')) }, cancel: cancelled }) }
        expect(cancelled).toHaveBeenCalledTimes(1)
        expect(init.headers?.Range).toBe('bytes=1-')
        return { ok: true, status: 206, headers: new Headers({ 'content-length': '2', 'content-range': 'bytes 1-2/3' }), body: new Response('BC').body }
      } })
      expect(readFileSync(dest, 'utf8')).toBe('ABC')
      expect(() => firstController.enqueue(Buffer.from('late'))).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('supports more than eight useful segments but bounds continuous tiny-segment progress', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const dir = mkdtempSync(path.join(tmpdir(), 'upd-')), dest = path.join(dir, 'app.exe')
    let requests = 0
    try {
      await expect(downloadResumable('https://synthetic.invalid/app.exe', dest, { totalSize: 100, fetcher: async () => {
        const start = requests++
        if (requests === 12) vi.setSystemTime(Date.now() + 31 * 60 * 1000)
        return { ok: true, status: 206, headers: new Headers({ 'content-length': '1', 'content-range': `bytes ${start}-${start}/100` }), body: new Response('A').body }
      } })).rejects.toThrow('耗时过长')
      expect(requests).toBe(12)
      expect(readFileSync(dest, 'utf8')).toBe('A'.repeat(12))
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('verifySha512File', () => {
  it('validates against the manifest base64 digest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'upd-'))
    const file = path.join(dir, 'app.exe')
    writeFileSync(file, 'installer bytes')
    const digest = createHash('sha512').update('installer bytes').digest('base64')
    expect(verifySha512File(file, digest)).toBe(true)
    expect(verifySha512File(file, 'wrong-digest==')).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('Windows updater lifecycle', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const payload = 'synthetic installer'
  let updater: typeof import('../updater')
  beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    updaterMocks.temp = mkdtempSync(path.join(tmpdir(), 'upd-win-'))
    updaterMocks.version = '2.2.2'
    updaterMocks.fetch.mockImplementation(async (url: string) => url.endsWith('latest.yml')
      ? new Response(JSON.stringify({ version: updaterMocks.version, files: [{ url: 'TouShou-x64.exe', sha512: createHash('sha512').update(payload).digest('base64'), size: Buffer.byteLength(payload) }] }))
      : new Response(payload, { headers: { 'content-length': String(Buffer.byteLength(payload)) } }))
    updaterMocks.proxy.mockImplementation(async () => updaterMocks.fetch)
    updaterMocks.fallback.mockRejectedValue(new Error('synthetic fallback failure'))
    updaterMocks.direct.mockImplementation((_url, options) => {
      const request = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }
      request.setTimeout = vi.fn(); request.destroy = vi.fn()
      options.signal?.addEventListener('abort', () => request.emit('error', new Error('synthetic abort')), { once: true })
      return request
    })
    updater = await import('../updater')
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.clearAllTimers(); vi.useRealTimers()
    rmSync(updaterMocks.temp, { recursive: true, force: true })
  })

  it('releases its active flag when the manifest has no newer version', async () => {
    updaterMocks.version = '2.2.1'
    expect(await updater.updaterDownload()).toEqual({ status: 'none' })
    updaterMocks.version = '2.2.2'
    expect(await updater.updaterDownload()).toEqual({ status: 'downloaded', version: '2.2.2' })
    expect(updaterMocks.fetch).toHaveBeenCalledTimes(3)
  })

  it.each(['proxy-setup', 'fetch', 'response-body'] as const)('bounds %s plus a stalled direct manifest fallback', async phase => {
    vi.useFakeTimers()
    const never = () => new Promise<never>(() => {})
    if (phase === 'proxy-setup') updaterMocks.proxy.mockImplementation(never)
    if (phase === 'fetch') updaterMocks.fetch.mockImplementation(never)
    if (phase === 'response-body') updaterMocks.fetch.mockResolvedValue({ ok: true, text: never })
    const pending = updater.updaterDownload()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await pending).toMatchObject({ status: 'error', operation: 'download' })
    expect(updaterMocks.fallback).toHaveBeenCalledTimes(1)
    expect(updaterMocks.direct).toHaveBeenCalledTimes(1)
    expect(updaterMocks.direct.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it.each(['error', 'aborted', 'close'] as const)('handles direct manifest body %s without an unhandled stream event', async event => {
    updaterMocks.proxy.mockRejectedValue(new Error('synthetic proxy failure'))
    updaterMocks.direct.mockImplementation((_url, _options, callback) => {
      const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
      const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, complete: false, setEncoding: vi.fn(), resume: vi.fn() })
      void Promise.resolve().then(() => { callback(response); response.emit(event, new Error('synthetic response failure')) })
      return request
    })
    expect(await updater.updaterDownload()).toMatchObject({ status: 'error', operation: 'download' })
    expect(updaterMocks.fallback).toHaveBeenCalledTimes(1)
  })

  it('cancels a late manifest response without reading its body after the deadline', async () => {
    vi.useFakeTimers()
    let resolve!: (response: unknown) => void
    updaterMocks.fetch.mockImplementation(() => new Promise(value => { resolve = value }))
    const pending = updater.updaterDownload()
    await vi.advanceTimersByTimeAsync(20_000)
    const cancel = vi.fn(), text = vi.fn()
    resolve({ ok: true, body: { cancel }, text })
    await vi.advanceTimersByTimeAsync(20_000)
    await pending
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(text).not.toHaveBeenCalled()
  })

  it('attempts to cancel a stalled manifest body when its read deadline expires', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    updaterMocks.fetch.mockResolvedValue({ ok: true, body: { cancel }, text: () => new Promise(() => {}) })
    const pending = updater.updaterDownload()
    await vi.advanceTimersByTimeAsync(40_000)
    await pending
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('requests NSIS relaunch and only quits after the installer successfully spawns', async () => {
    expect((await updater.updaterDownload()).status).toBe('downloaded')
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    updaterMocks.spawn.mockReturnValue(child)
    updater.updaterQuitAndInstall()
    expect(updaterMocks.spawn.mock.calls[0][1]).toEqual(['--updated', '/S', '--force-run'])
    expect(updaterMocks.quit).not.toHaveBeenCalled()
    child.emit('spawn')
    expect(updaterMocks.quit).toHaveBeenCalledTimes(1)
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('reports an asynchronous spawn failure without quitting and permits a retry', async () => {
    await updater.updaterDownload()
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    updaterMocks.spawn.mockReturnValue(child)
    updater.updaterQuitAndInstall()
    child.emit('error', new Error('synthetic launch failure'))
    expect(updaterMocks.quit).not.toHaveBeenCalled()
    expect(updater.getUpdaterStatus()).toMatchObject({ status: 'error', operation: 'install' })
    updater.updaterQuitAndInstall()
    expect(updaterMocks.spawn).toHaveBeenCalledTimes(2)
  })
})
