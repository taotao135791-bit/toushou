import { describe, expect, it } from 'vitest'
import {
  clearComposerDraft,
  ComposerDrafts,
  pruneComposerDrafts,
  setComposerDraft
} from './composerDraft'

const image = { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }

function draft(text: string, withImage = false) {
  return { text, images: withImage ? [image] : [] }
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
})
