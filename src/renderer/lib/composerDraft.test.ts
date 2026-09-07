import { describe, expect, it } from 'vitest'
import {
  clearComposerDraft,
  ComposerDraftFile,
  ComposerDrafts,
  SessionComposerDraft,
  pruneComposerDrafts,
  setComposerDraft
} from './composerDraft'

const image = { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }

function draftFile(path: string, kind: ComposerDraftFile['kind'] = 'file'): ComposerDraftFile {
  return { path, name: path.split('/').pop() ?? path, isDirectory: kind === 'folder', kind }
}

function draft(text: string, withImage = false, withFiles: ComposerDraftFile[] = []) {
  return {
    text,
    images: withImage ? [image] : [],
    ...(withFiles.length ? { files: withFiles } : {})
  }
}

describe('session-scoped composer drafts', () => {
  it('keeps A draft out of B and restores it after A ↔ B switching', () => {
    let drafts: ComposerDrafts = {}
    drafts = setComposerDraft(drafts, 'A', draft('AAA'))

    expect(drafts.B).toBeUndefined()

    drafts = setComposerDraft(drafts, 'B', draft('BBB'))
    expect(drafts.A.text).toBe('AAA')
    expect(drafts.B.text).toBe('BBB')
    expect(drafts.A.text).toBe('AAA')
  })

  it('clears only the sent session draft', () => {
    let drafts: ComposerDrafts = {}
    drafts = setComposerDraft(drafts, 'A', draft('AAA'))
    drafts = setComposerDraft(drafts, 'B', draft('BBB', true))
    drafts = clearComposerDraft(drafts, 'A')

    expect(drafts.A).toBeUndefined()
    expect(drafts.B).toEqual(draft('BBB', true))
  })

  it('starts a new session empty and isolates staged images', () => {
    let drafts: ComposerDrafts = {}
    drafts = setComposerDraft(drafts, 'A', draft('AAA', true))
    drafts = setComposerDraft(drafts, 'C', draft(''))

    expect(drafts.C).toBeUndefined()
    expect(drafts.A.images).toHaveLength(1)
  })

  it('removes drafts when their sessions are deleted', () => {
    let drafts: ComposerDrafts = {}
    drafts = setComposerDraft(drafts, 'A', draft('AAA'))
    drafts = setComposerDraft(drafts, 'B', draft('BBB'))

    const remaining = pruneComposerDrafts(drafts, new Set(['B']))
    expect(remaining).toEqual({ B: draft('BBB') })
  })

  it('persists attachment chips alongside text+images, isolated per session', () => {
    let drafts: ComposerDrafts = {}
    drafts = setComposerDraft(drafts, 'A', draft('AAA', true, [draftFile('/tmp/report.zip', 'archive')]))
    drafts = setComposerDraft(drafts, 'B', draft('BBB', false, [draftFile('/tmp/shots', 'folder')]))

    expect(drafts.A.files).toEqual([draftFile('/tmp/report.zip', 'archive')])
    expect(drafts.A.images).toHaveLength(1)
    expect(drafts.B.files).toEqual([draftFile('/tmp/shots', 'folder')])
  })

  it('keeps a draft that only carries attachment chips', () => {
    let drafts: ComposerDrafts = {}
    drafts = setComposerDraft(drafts, 'A', draft('', false, [draftFile('/tmp/plan.xlsx')]))
    expect(drafts.A?.files).toHaveLength(1)

    // Clearing the chips empties the draft again.
    drafts = setComposerDraft(drafts, 'A', draft('', false, []))
    expect(drafts.A).toBeUndefined()
  })

  it('still loads drafts written before attachment chips existed', () => {
    let drafts: ComposerDrafts = {}
    const legacy: SessionComposerDraft = { text: 'legacy', images: [image] }
    drafts = setComposerDraft(drafts, 'A', legacy)

    expect(drafts.A).toEqual(legacy)
    expect(drafts.A?.files).toBeUndefined()

    drafts = clearComposerDraft(drafts, 'A')
    expect(drafts.A).toBeUndefined()
  })
})
