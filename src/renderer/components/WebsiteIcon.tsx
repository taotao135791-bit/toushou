import { memo, useEffect, useRef, useState } from 'react'
import { Globe2 } from 'lucide-react'
import type { SiteIconResult } from '@shared/siteIcon'
import type { ToolBrand } from '../lib/toolBrand'
import BrandIcon from './BrandIcon'

interface Props { url: string; hostname?: string; size?: number; className?: string }
const cache = new Map<string, { expires: number; result: Promise<SiteIconResult> }>()
const knownSites: readonly (readonly [string, ToolBrand])[] = [
  ['facebook.com', 'facebook'], ['tiktok.com', 'tiktok'], ['feishu.cn', 'feishu'],
  ['ads.google.com', 'google'], ['figma.com', 'figma'], ['appsflyer.com', 'appsflyer']
]

function iconFor(host: string): Promise<SiteIconResult> {
  const previous = cache.get(host)
  if (previous && previous.expires > Date.now()) return previous.result
  const entry = { expires: Date.now() + 180_000, result: Promise.resolve<SiteIconResult>({ ok: false }) }
  entry.result = Promise.resolve().then(() => window.electronAPI.getSiteIcon(host)).catch((): SiteIconResult => ({ ok: false })).then(result => {
    entry.expires = Date.now() + (result.ok ? 6 * 60 * 60_000 : 5 * 60_000)
    return result
  })
  cache.delete(host)
  cache.set(host, entry)
  while (cache.size > 128) cache.delete(cache.keys().next().value!)
  return entry.result
}

/** Visible sources only. Main receives a hostname, never URL paths or account queries. */
export default memo(function WebsiteIcon({ url, hostname, size = 16, className = '' }: Props) {
  const element = useRef<HTMLSpanElement>(null)
  const [loaded, setLoaded] = useState<{ host: string; src: string } | null>(null)
  let host = ''
  try {
    const parsed = new URL(url)
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password && (!hostname || hostname === parsed.hostname)) host = parsed.hostname.toLowerCase()
  } catch { /* Invalid sources keep the neutral fallback. */ }
  const brand = knownSites.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1]
  useEffect(() => {
    if (!host || brand || !element.current) return
    let current = true
    const load = () => {
      void iconFor(host).then(result => {
        if (current && result.ok && result.dataUrl.length <= 350_000 && /^data:image\/(?:png|x-icon);base64,[A-Za-z0-9+/]+=*$/.test(result.dataUrl)) setLoaded({ host, src: result.dataUrl })
      })
    }
    if (typeof IntersectionObserver === 'undefined') { load(); return () => { current = false } }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      load()
    }, { rootMargin: '80px' })
    observer.observe(element.current)
    return () => { current = false; observer.disconnect() }
  }, [host, brand])
  const pixels = Number.isFinite(size) ? Math.max(12, Math.min(32, size)) : 16
  const src = loaded?.host === host ? loaded.src : null
  return <span ref={element} aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center align-middle ${className}`} style={{ width: pixels, height: pixels }}>
    {brand ? <BrandIcon brand={brand} size={pixels} /> : src ? <img src={src} alt="" width={pixels} height={pixels} draggable={false} className="block h-full w-full rounded-[3px] bg-white object-contain p-px" onError={() => setLoaded(null)} /> : <Globe2 size={pixels} className="text-cream-faint" />}
  </span>
})
