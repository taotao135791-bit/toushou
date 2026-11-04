import dns from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import type { SiteIconResult } from '../shared/siteIcon'
import { requestPublicIconFallback } from './siteIconFallback'

const FAIL: SiteIconResult = { ok: false }
const MAX_BYTES = 256 * 1024
const MAX_DIMENSION = 512
const DEFAULT_DEADLINE = 5000
const DIRECT_REQUEST_DEADLINE = 1200
const forbiddenSuffixes = new Set(['local', 'localhost', 'localdomain', 'internal', 'invalid', 'test', 'example', 'onion', 'lan', 'home', 'corp', 'private', 'arpa'])

/** Accept only canonical DNS names, never a URL, IP literal or local suffix. */
export function validSiteHostname(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 253 || value.length < 3 || value !== value.trim() || !/^[a-z0-9.-]+$/i.test(value)) return null
  const host = value.toLowerCase()
  if (net.isIP(host) || !host.includes('.') || host.endsWith('.')) return null
  const labels = host.split('.')
  if (labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null
  const tld = labels.at(-1)!
  if (!/^[a-z]{2,}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) return null
  if (forbiddenSuffixes.has(tld) || ['example.com', 'example.net', 'example.org'].some(reserved => host === reserved || host.endsWith(`.${reserved}`))) return null
  return host
}

/** Conservative IPv4 global-unicast filter: deny special-use and internal ranges. */
export function isPublicIPv4(address: string): boolean {
  if (net.isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false
  return true
}

interface Raster { width: number; height: number }
function pngSize(data: Buffer): Raster | null {
  if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null
  let offset = 8, dimensions: Raster | null = null, seenData = false, dataEnded = false
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset)
    if (length > data.length - offset - 12) return null
    const type = data.toString('ascii', offset + 4, offset + 8)
    const next = offset + length + 12
    if (!/^[A-Za-z]{4}$/.test(type) || ['acTL', 'fcTL', 'fdAT'].includes(type)) return null
    if (!dimensions) {
      if (type !== 'IHDR' || length !== 13) return null
      const width = data.readUInt32BE(offset + 8), height = data.readUInt32BE(offset + 12)
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return null
      dimensions = { width, height }
    } else if (type === 'IHDR') return null
    if (type === 'IDAT') {
      if (dataEnded) return null
      seenData = true
    } else if (seenData && type !== 'IEND') dataEnded = true
    if (type === 'IEND') return length === 0 && seenData && next === data.length ? dimensions : null
    offset = next
  }
  return null
}
/** Validate PNG/ICO structure, dimensions and bounded size before renderer decoding. */
export function validRaster(data: Buffer, mime: string): boolean {
  const type = mime.split(';', 1)[0].trim().toLowerCase()
  if (data.length > MAX_BYTES || data.length === 0) return false
  if (type === 'image/png') return pngSize(data) !== null
  if (type !== 'image/x-icon' && type !== 'image/vnd.microsoft.icon') return false
  if (data.length < 22 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return false
  const count = data.readUInt16LE(4)
  if (count < 1 || count > 16 || data.length < 6 + count * 16) return false
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16, width = data[offset] || 256, height = data[offset + 1] || 256
    const length = data.readUInt32LE(offset + 8), start = data.readUInt32LE(offset + 12)
    if (!length || start < 6 + count * 16 || start + length > data.length) return false
    const image = data.subarray(start, start + length)
    if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const png = pngSize(image)
      if (!png || png.width !== width || png.height !== height) return false
    } else {
      if (image.length < 40 || image.readUInt32LE(0) < 40 || image.readUInt32LE(0) > image.length) return false
      if (image.readInt32LE(4) !== width || image.readInt32LE(8) !== height * 2 || image.readUInt16LE(12) !== 1 || ![1, 4, 8, 24, 32].includes(image.readUInt16LE(14)) || image.readUInt32LE(16) !== 0) return false
    }
  }
  return true
}

interface IconResponse { bytes: Buffer; mime: string }
type RequestFunction = typeof https.request
/** One direct request, with a validated address pinned at connection time. */
export function requestSiteIcon(hostname: string, address: string, signal: AbortSignal, request: RequestFunction = https.request): Promise<IconResponse> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = () => { if (!settled) { settled = true; reject(new Error('icon-unavailable')) } }
    const req = request({ protocol: 'https:', hostname, port: 443, path: '/favicon.ico', method: 'GET', servername: hostname, family: 4, rejectUnauthorized: true, agent: false,
      headers: { Accept: 'image/png, image/x-icon, image/vnd.microsoft.icon', 'Accept-Encoding': 'identity' },
      lookup: (_host, _opts, callback) => callback(null, address, 4), signal }, response => {
      const mime = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : ''
      const encoding = response.headers['content-encoding']
      const declared = response.headers['content-length']
      if (response.statusCode !== 200 || (encoding && encoding.toLowerCase() !== 'identity') || (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) || !['image/png', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(mime.split(';', 1)[0].trim().toLowerCase())) { response.destroy(); fail(); return }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) { response.destroy(); fail() } else chunks.push(chunk) })
      response.once('error', fail)
      response.once('aborted', fail)
      response.once('end', () => { if (!settled) { settled = true; resolve({ bytes: Buffer.concat(chunks), mime }) } })
    })
    req.once('error', fail)
    req.end()
  })
}
function encodeImage(bytes: Buffer, mime: string): string {
  const type = mime.split(';', 1)[0].trim().toLowerCase()
  return `data:${type === 'image/png' ? 'image/png' : 'image/x-icon'};base64,${bytes.toString('base64')}`
}

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>
interface Dependencies {
  lookup?: Lookup
  request?: (host: string, address: string, signal: AbortSignal) => Promise<IconResponse>
  fallback?: (host: string, signal: AbortSignal) => Promise<IconResponse | null>
  now?: () => number
  deadlineMs?: number
  concurrency?: number
  queueLimit?: number
}
interface Job { host: string; controller: AbortController; done: boolean; timer: ReturnType<typeof setTimeout>; resolve: (value: SiteIconResult) => void }
export function createSiteIconService(deps: Dependencies = {}) {
  const lookup: Lookup = deps.lookup ?? (host => dns.lookup(host, { family: 4, all: true }))
  const request = deps.request ?? requestSiteIcon
  const fallback = deps.fallback ?? requestPublicIconFallback
  const now = deps.now ?? Date.now
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE
  const concurrency = deps.concurrency ?? 4, queueLimit = deps.queueLimit ?? 32
  const cache = new Map<string, { value: SiteIconResult; expires: number }>()
  const inflight = new Map<string, Promise<SiteIconResult>>()
  const queue: Job[] = []
  let active = 0
  const finish = (job: Job, value: SiteIconResult) => {
    if (job.done) return
    job.done = true; clearTimeout(job.timer); inflight.delete(job.host)
    cache.delete(job.host); cache.set(job.host, { value, expires: now() + (value.ok ? 6 * 60 * 60_000 : 5 * 60_000) })
    while (cache.size > 128) cache.delete(cache.keys().next().value!)
    job.resolve(value)
  }
  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift()!
      if (job.done) continue
      active++
      void (async () => {
        try {
          const addresses = await lookup(job.host)
          if (job.controller.signal.aborted || !addresses.length) return FAIL
          const isFakeProxyAddress = (address: string) => net.isIP(address) === 4 && /^198\.(?:18|19)\./.test(address)
          // Fake-IP proxy answers never become origin destinations. Other private or mixed
          // internal answers remain blocked and are not disclosed to the public provider.
          if (addresses.some(item => item.family !== 4 || (!isPublicIPv4(item.address) && !isFakeProxyAddress(item.address)))) return FAIL
          const resultFor = (response: IconResponse | null): SiteIconResult => {
            if (!response || job.controller.signal.aborted || !validRaster(response.bytes, response.mime)) return FAIL
            const dataUrl = encodeImage(response.bytes, response.mime)
            return /^data:image\/(?:png|x-icon);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) && dataUrl.length <= Math.ceil(MAX_BYTES / 3) * 4 + 32 ? { ok: true, dataUrl } : FAIL
          }
          if (addresses.every(item => isPublicIPv4(item.address))) {
            const direct = new AbortController()
            const abortDirect = () => direct.abort()
            job.controller.signal.addEventListener('abort', abortDirect, { once: true })
            const timeout = setTimeout(abortDirect, DIRECT_REQUEST_DEADLINE)
            try {
              const result = resultFor(await request(job.host, addresses[0].address, direct.signal))
              if (result.ok) return result
            } catch { /* The fixed public provider can supply an icon when an origin cannot. */ }
            finally { clearTimeout(timeout); job.controller.signal.removeEventListener('abort', abortDirect) }
          }
          if (job.controller.signal.aborted) return FAIL
          return resultFor(await fallback(job.host, job.controller.signal))
        } catch { return FAIL }
      })().then(value => finish(job, value)).finally(() => { active--; pump() })
    }
  }
  const get = (input: unknown): Promise<SiteIconResult> => {
    const host = validSiteHostname(input)
    if (!host) return Promise.resolve(FAIL)
    const cached = cache.get(host)
    if (cached && cached.expires > now()) { cache.delete(host); cache.set(host, cached); return Promise.resolve(cached.value) }
    if (cached) cache.delete(host)
    const pending = inflight.get(host)
    if (pending) return pending
    if (active >= concurrency && queue.length >= queueLimit) return Promise.resolve(FAIL)
    let job!: Job
    const promise = new Promise<SiteIconResult>(resolve => {
      const controller = new AbortController()
      job = { host, controller, done: false, resolve, timer: setTimeout(() => { controller.abort(); const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); finish(job, FAIL) }, deadlineMs) }
    })
    inflight.set(host, promise); queue.push(job); pump()
    return promise
  }
  return { get }
}
export const siteIconService = createSiteIconService()
