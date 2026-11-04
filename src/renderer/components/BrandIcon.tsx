import { useState } from 'react'
import { Wrench } from 'lucide-react'
import type { ToolBrand } from '../lib/toolBrand'
import facebook from '../assets/brands/facebook.png'
import tiktok from '../assets/brands/tiktok.png'
import feishu from '../assets/brands/feishu.png'
import google from '../assets/brands/google-ads.svg'
import figma from '../assets/brands/figma.svg'
import appsflyer from '../assets/brands/appsflyer.png'

const images: Record<ToolBrand, string> = { facebook, tiktok, feishu, google, figma, appsflyer }

interface Props { brand?: ToolBrand | null; size?: number; className?: string; title?: string }

/** Bundled official artwork only: no network request, recoloring or guessed initials. */
export default function BrandIcon({ brand, size = 16, className = '', title }: Props) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = brand ? images[brand] : undefined
  const pixels = Number.isFinite(size) ? Math.max(12, Math.min(64, size)) : 16
  return <span role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}
    title={title} className={`inline-flex shrink-0 items-center justify-center align-middle ${className}`}
    style={{ width: pixels, height: pixels }}>
    {src && failed !== src ? <img src={src} alt="" width={pixels} height={pixels} draggable={false}
      className="block h-full w-full object-contain" onError={() => setFailed(src)} /> :
      <Wrench size={Math.max(12, pixels * 0.8)} className="text-cream-faint" aria-hidden="true" />}
  </span>
}
