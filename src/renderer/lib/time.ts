import type { Language } from '@shared/types'
import { translate } from '../i18n'

/**
 * Compact relative timestamp for the session/history rows:
 * <60s seconds, <60min minutes, <24h hours, <7d days, otherwise MM-DD
 * ("19秒钟" / "19s ago").
 */
export function formatRelativeTime(ts: number, lang: Language): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60)
    return translate(lang, 'sidebar.time.secondsAgo', { count: Math.max(1, seconds) })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return translate(lang, 'sidebar.time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return translate(lang, 'sidebar.time.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return translate(lang, 'sidebar.time.daysAgo', { count: days })
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Compact duration in seconds: one decimal under 10s ("9.6"), rounded after ("37"). */
export function formatSeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s >= 10) return String(Math.round(s))
  return (Math.round(s * 10) / 10).toString()
}
