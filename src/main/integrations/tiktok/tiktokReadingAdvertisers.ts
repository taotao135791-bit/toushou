import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  normalizeTikTokAdvertiserIds,
  parseTikTokAdvertiserIdList,
  type TikTokReadingAdvertisersSetResult
} from '../../../shared/tiktokReport'

/**
 * Advertisers the board reads when the user lists them by hand
 * (userData/tiktok-reading-advertisers.json). The official connection's token
 * does not always carry its advertiser ids, and a BASIC report cannot run
 * without one. Ids are not secrets; the file holds nothing else.
 */
export const TIKTOK_READING_ADVERTISERS_FILE = 'tiktok-reading-advertisers.json'

function defaultFile(): string {
  return path.join(app.getPath('userData'), TIKTOK_READING_ADVERTISERS_FILE)
}

export function listTikTokReadingAdvertisers(file?: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(file ?? defaultFile(), 'utf-8')) as { advertiserIds?: unknown } | null
    return normalizeTikTokAdvertiserIds(raw?.advertiserIds)
  } catch {
    return []
  }
}

/** IPC entry: `{ advertiserIds: "7300…, 7311…" }`. Blank text clears the list. */
export function setTikTokReadingAdvertisers(raw: unknown, file?: string): TikTokReadingAdvertisersSetResult {
  const text = raw && typeof raw === 'object' ? (raw as { advertiserIds?: unknown }).advertiserIds : undefined
  const ids = parseTikTokAdvertiserIdList(text)
  if (!ids) return { ok: false, error: 'invalid-input' }
  try {
    const target = file ?? defaultFile()
    mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify({ advertiserIds: ids }, null, 2) + '\n', 'utf-8')
    renameSync(tmp, target)
  } catch {
    return { ok: false, error: 'write-failed' }
  }
  return { ok: true, selected: ids }
}
