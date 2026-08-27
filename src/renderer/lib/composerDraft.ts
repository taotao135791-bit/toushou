import { PromptImage } from '@shared/types'

/** Unsent composer state that belongs to one runtime session. */
export interface SessionComposerDraft {
  text: string
  images: PromptImage[]
}

export type ComposerDrafts = Record<string, SessionComposerDraft>

export function setComposerDraft(
  drafts: ComposerDrafts,
  sessionId: string,
  draft: SessionComposerDraft
): ComposerDrafts {
  if (draft.text.length === 0 && draft.images.length === 0) {
    return clearComposerDraft(drafts, sessionId)
  }
  return { ...drafts, [sessionId]: draft }
}

export function clearComposerDraft(drafts: ComposerDrafts, sessionId: string): ComposerDrafts {
  if (!(sessionId in drafts)) return drafts
  const next = { ...drafts }
  delete next[sessionId]
  return next
}

export function pruneComposerDrafts(drafts: ComposerDrafts, sessionIds: Set<string>): ComposerDrafts {
  const next = Object.fromEntries(
    Object.entries(drafts).filter(([sessionId]) => sessionIds.has(sessionId))
  )
  return Object.keys(next).length === Object.keys(drafts).length ? drafts : next
}
