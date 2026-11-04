import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

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
        res.writeHead(206, { 'content-length': slice.length })
        res.write(slice.subarray(0, options.dropAfter))
        setTimeout(() => res.destroy(), 10)
        return
      }
      res.writeHead(206, { 'content-length': slice.length })
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
