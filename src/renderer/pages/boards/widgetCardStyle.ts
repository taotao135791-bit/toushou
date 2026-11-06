import type { CSSProperties } from 'react'
import type { BoardWidgetStyle } from '@shared/types'

type BoardCssProperties = CSSProperties & Record<`--${string}`, string | number>
type RGB = [number, number, number]
const rgb = (hex: string | undefined): RGB | null => hex && /^#[0-9a-f]{6}$/i.test(hex)
  ? [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] : null
const channels = (color: RGB) => color.join(' ')
const color = (value: RGB) => `rgb(${channels(value)})`
const blend = (foreground: RGB, background: RGB, weight: number): RGB => foreground.map((channel, index) => Math.round(channel * weight + background[index] * (1 - weight))) as RGB
const luminance = (value: RGB) => value.map(channel => { const n = channel / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4 }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0)
const contrast = (a: RGB, b: RGB) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
function readableBlend(foreground: RGB, surface: RGB, weight: number): RGB {
  for (let current = weight; current < 1; current += 0.04) {
    const candidate = blend(foreground, surface, current)
    if (contrast(candidate, surface) >= 4.5) return candidate
  }
  return foreground
}

/** Local semantic palette: custom content and controls inherit it; defaults stay unchanged. */
export function widgetCardStyle(style?: BoardWidgetStyle): BoardCssProperties {
  const surface = rgb(style?.surface), explicitText = rgb(style?.text), accent = rgb(style?.accent), border = rgb(style?.border)
  const foreground: RGB | null = explicitText ?? (surface ? (contrast([0, 0, 0], surface) >= contrast([255, 255, 255], surface) ? [0, 0, 0] : [255, 255, 255]) : null)
  const result: BoardCssProperties = {
    borderRadius: `${style?.radius ?? 16}px`,
    boxShadow: style?.shadow === 'none' ? 'none' : style?.shadow === 'strong' ? '0 16px 36px rgba(0, 0, 0, 0.30)' : 'var(--shadow-card)',
    '--board-widget-accent': accent ? style!.accent! : 'rgb(var(--accent))',
    '--board-widget-text': foreground ? color(foreground) : 'rgb(var(--text))',
    '--board-widget-border': border ? style!.border! : 'var(--line)'
  }
  if (surface) {
    result.backgroundColor = style!.surface
    for (const key of ['--bg-app', '--bg-sidebar', '--bg-elev', '--bg-sunken', '--bg-selected', '--bubble'] as const) result[key] = channels(surface)
  }
  if (foreground) {
    result['--text'] = channels(foreground)
    const dim = surface ? readableBlend(foreground, surface, 0.76) : foreground
    const faint = surface ? readableBlend(foreground, surface, 0.64) : foreground
    result['--text-dim'] = channels(dim)
    result['--text-faint'] = channels(faint)
    result['--board-widget-text-dim'] = surface ? color(dim) : `color-mix(in srgb, ${color(foreground)} 76%, transparent)`
    result['--board-widget-text-faint'] = surface ? color(faint) : `color-mix(in srgb, ${color(foreground)} 64%, transparent)`
    if (surface) {
      result['--line'] = border ? style!.border! : `rgb(${channels(foreground)} / 0.14)`
      result['--line-strong'] = border ? style!.border! : `rgb(${channels(foreground)} / 0.24)`
      result['--overlay'] = `rgb(${channels(foreground)} / 0.06)`
      result['--overlay-strong'] = `rgb(${channels(foreground)} / 0.10)`
    }
  }
  if (accent) {
    result['--accent'] = channels(accent)
    result['--accent-bright'] = channels(blend(accent, [255, 255, 255], 0.8))
    result['--accent-deep'] = channels(blend(accent, [0, 0, 0], 0.85))
    result['--accent-soft'] = `rgb(${channels(accent)} / 0.14)`
  }
  if (border) { result.borderColor = style!.border; result['--line'] = style!.border!; result['--line-strong'] = style!.border! }
  return result
}
