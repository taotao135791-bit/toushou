import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const { loadComposerDrafts, saveComposerDrafts } = await import('../composerDraftsFile')
const validDraft = {
  text: '写到一半的话',
  images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
  files: [{ path: 'D:/x/report.zip', name: 'report.zip', isDirectory: false, kind: 'archive' as const }]
}
const textDraft = (text: string) => ({ text, images: [] })

beforeEach(() => { userData = mkdtempSync(path.join(tmpdir(), 'composer-drafts-')) })
afterEach(() => rmSync(userData, { force: true, recursive: true }))

describe('composer-drafts file persistence', () => {
  it('round-trips images and attachments with per-conversation changes', async () => {
    expect(await saveComposerDrafts({ sessionA: validDraft, '__new-chat__': textDraft('未发送') })).toBe(true)
    expect(await saveComposerDrafts({ '__new-chat__': textDraft('second chat') })).toBe(true)
    expect(await loadComposerDrafts()).toEqual({ sessionA: validDraft, '__new-chat__': textDraft('second chat') })
  })

  it('keeps saving valid entries when another entry is oversized or malformed', async () => {
    expect(await saveComposerDrafts({ a: textDraft('previous') })).toBe(true)
    expect(await saveComposerDrafts({
      a: textDraft('x'.repeat(1_000_001)),
      b: textDraft('new'),
      bad: { text: 123 },
      machine: { text: 'x', images: [{ type: 'video', data: '', mimeType: '' }] }
    })).toBe(false)
    expect(await loadComposerDrafts()).toEqual({ a: textDraft('previous'), b: textDraft('new') })
  })

  it('saves cumulative normal pastes and deletes only explicitly cleared keys', async () => {
    const long = textDraft('x'.repeat(270_000))
    expect(await saveComposerDrafts({ a: long, b: validDraft })).toBe(true)
    expect(await saveComposerDrafts({ b: null })).toBe(true)
    expect(await loadComposerDrafts()).toEqual({ a: long })
  })

  it('recovers legacy drafts without changing the current copy', async () => {
    const file = path.join(userData, 'composer-drafts.json')
    writeFileSync(file, JSON.stringify({ good: validDraft, ugly: { nonsense: true }, '': validDraft }))
    expect(await loadComposerDrafts()).toEqual({ good: validDraft })
    expect(await saveComposerDrafts({ good: null })).toBe(true)
    expect(await loadComposerDrafts()).toEqual({})
  })

  it('keeps a corrupt legacy backup and persists new drafts', async () => {
    const file = path.join(userData, 'composer-drafts.json')
    writeFileSync(file, '{not json', 'utf-8')
    expect(await loadComposerDrafts()).toEqual({})
    expect(await saveComposerDrafts({ a: validDraft })).toBe(true)
    expect(await loadComposerDrafts()).toEqual({ a: validDraft })
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe('{not json')
  })

  it('serializes overlapping writes and removes temp files', async () => {
    await Promise.all([saveComposerDrafts({ a: validDraft }), saveComposerDrafts({ a: null })])
    expect(await loadComposerDrafts()).toEqual({})
    expect(readdirSync(path.join(userData, 'composer-drafts'))).toEqual([])
  })
})
