import { BrowserWindow, session } from 'electron'
import { createHash } from 'node:crypto'
import { get, type ClientRequest } from 'node:http'
import { resolveEnvProxyRules } from '../tiktok/envProxy'

/**
 * Isolated OAuth page. Only the exact registered loopback callback is
 * forwarded; state/code validation remains with the Main-owned listener.
 */
export interface AuthWindowHandle {
  ready: Promise<void>
  done: Promise<'redirected' | 'closed'>
  close(): void
}

export function openAuthWindow(authorizationUrl: string, redirectUri: string): AuthWindowHandle {
  const authorization = new URL(authorizationUrl)
  const callback = new URL(redirectUri)
  if (authorization.origin !== 'https://mcp.appsflyer.com' || authorization.username || authorization.password || authorization.hash
    || authorization.searchParams.getAll('redirect_uri').length !== 1 || authorization.searchParams.get('redirect_uri') !== callback.href
    || callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port || callback.pathname !== '/callback'
    || callback.username || callback.password || callback.search || callback.hash) throw new Error('Invalid authorization window')
  const partition = `appsflyer-auth-${createHash('sha256').update(authorizationUrl).digest('hex').slice(0, 24)}`
  const ses = session.fromPartition(partition)
  ses.setPermissionRequestHandler((_contents, _permission, reply) => reply(false))
  ses.setPermissionCheckHandler(() => false)
  let settled = false
  let closed = false
  let pendingCallback: ClientRequest | null = null
  let resolveDone!: (value: 'redirected' | 'closed') => void
  const done = new Promise<'redirected' | 'closed'>(resolve => { resolveDone = resolve })
  const settle = (value: 'redirected' | 'closed') => {
    if (settled) return
    settled = true
    resolveDone(value)
  }
  const win = new BrowserWindow({
      width: 480,
      height: 720,
      title: 'AppsFlyer',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
  })
  const close = () => {
    closed = true
    pendingCallback?.destroy()
    pendingCallback = null
    if (!win.isDestroyed()) win.close()
    settle('closed')
  }
  win.once('ready-to-show', () => { if (!closed) win.show() })
  win.on('closed', () => {
    closed = true
    pendingCallback?.destroy()
    pendingCallback = null
    settle('closed')
  })
  const isCallback = (url: URL) => url.origin === callback.origin && url.pathname === callback.pathname && !url.username && !url.password && !url.hash
  const forward = (url: URL) => {
    if (closed || pendingCallback) return
    // No browser cookies, proxy, credentials or redirects reach this GET.
    const request = get(url, { agent: false, headers: { 'cache-control': 'no-store' } }, response => {
      response.resume()
      response.on('end', () => {
        if (pendingCallback !== request) return
        pendingCallback = null
        if (!closed && (response.statusCode === 200 || response.statusCode === 202)) {
          settle('redirected')
          close()
        }
      })
    })
    pendingCallback = request
    request.setTimeout(5_000, () => request.destroy())
    request.on('error', () => { if (pendingCallback === request) pendingCallback = null })
  }
  const navigate = (event: { preventDefault(): void }, target: string) => {
    let url: URL
    try { url = new URL(target) } catch { event.preventDefault(); return }
    if (isCallback(url)) {
      event.preventDefault()
      forward(url)
    } else if (url.protocol !== 'https:' || url.username || url.password) event.preventDefault()
  }
  win.webContents.on('will-navigate', navigate)
  win.webContents.on('will-redirect', navigate)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const ready = Promise.race([
    (async () => {
      await ses.setProxy(resolveEnvProxyRules(authorizationUrl))
      if (closed) throw new Error('Authorization window closed')
      await win.loadURL(authorizationUrl)
      if (closed) throw new Error('Authorization window closed')
    })(),
    new Promise<never>((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Authorization window unavailable')), 20_000) })
  ]).finally(() => clearTimeout(readyTimer))
  void ready.catch(() => close())
  return { ready, done, close }
}
