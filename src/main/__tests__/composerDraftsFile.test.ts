import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// app.getPath('userData') is redirected to a scratch dir per test.
const userData = mkdtempSync(path.join(tmpdir(), 'composer-drafts-'))
vi.mock('electron', () => ({
  app: {
    getPath: () => userData
  }
}))

const { loadComposerDrafts, saveComposerDrafts } = await import('../composerDraftsFile')

const validDraft = {
  text: '写到一半的话',
  images: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
  files: [{ path: 'D:/x/report.zip', name: 'report.zip', isDirectory: false, kind: 'archive' as const }]
}

beforeEach(() => {
  // Keep the scratch dir itself; only reset the drafts file between cases.
  mkdirSync(userData, { recursive: true })
  rmSync(path.join(userData, 'composer-drafts.json'), { force: true })
  rmSync(path.join(userData, 'composer-drafts.json.corrupt'), { force: true })
  rmSync(path.join(userData, 'composer-drafts.json.tmp'), { force: true })
})

describe('composer-drafts file persistence', () => {
  it('round-trips drafts through disk', () => {
    expect(saveComposerDrafts({ sessionA: validDraft, '__new-chat__': { text: '未发送', images: [] } })).toBe(true)
    expect(loadComposerDrafts()).toEqual({
      sessionA: validDraft,
      '__new-chat__': { text: '未发送', images: [] }
    })
  })

  it('rejects malformed drafts wholesale instead of writing them', () => {
    expect(saveComposerDrafts({ bad: { text: 123, images: [] } })).toBe(false)
    expect(saveComposerDrafts({ bad: { text: 'x', images: [{ type: 'video', data: '', mimeType: '' }] } })).toBe(false)
    expect(saveComposerDrafts('nope')).toBe(false)
    expect(loadComposerDrafts()).toEqual({})
  })

  it('caps what a single draft may carry', () => {
    const huge = { text: 'x'.repeat(200_001), images: [] }
    expect(saveComposerDrafts({ a: huge })).toBe(false)
    const manyImages = { text: '', images: Array.from({ length: 5 }, () => ({ type: 'image', data: '', mimeType: 'image/png' })) }
    expect(saveComposerDrafts({ a: manyImages })).toBe(false)
    // The renderer's own truncated paste (100_000 + ellipsis) must validate.
    expect(saveComposerDrafts({ a: { text: 'x'.repeat(100_001), images: [] } })).toBe(true)
  })

  it('degrades a corrupt file to empty drafts and preserves the bytes for recovery', () => {
    const file = path.join(userData, 'composer-drafts.json')
    writeFileSync(file, '{not json', 'utf-8')
    expect(loadComposerDrafts()).toEqual({})
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe('{not json')
  })

  it('drops only invalid entries when part of the file is stale', () => {
    const file = path.join(userData, 'composer-drafts.json')
    writeFileSync(
      file,
      JSON.stringify({ good: validDraft, ugly: { nonsense: true }, '': validDraft }),
      'utf-8'
    )
    expect(loadComposerDrafts()).toEqual({ good: validDraft })
  })

  it('writes atomically: no .tmp litter after a successful save', () => {
    expect(saveComposerDrafts({ a: validDraft })).toBe(true)
    const entries = loadComposerDrafts()
    expect(entries).toEqual({ a: validDraft })
    expect(() => readFileSync(path.join(userData, 'composer-drafts.json.tmp'))).toThrow()
  })
})
