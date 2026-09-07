import { PromptImage } from '@shared/types'

/** Visual class of a non-image attachment chip dropped into the composer. */
export type ComposerFileKind = 'folder' | 'archive' | 'file'

/** A non-image drop staged as an attachment chip (runtime representation). */
export interface DroppedAttachment {
  id: string
  /** Absolute filesystem path; falls back to the display name for virtual files. */
  path: string
  name: string
  isDirectory: boolean
  kind: ComposerFileKind
}

/** Draft-persisted form of an attachment chip: identity-free and structured. */
export interface ComposerDraftFile {
  path: string
  name: string
  isDirectory: boolean
  kind: ComposerFileKind
}

/** Unsent composer state that belongs to one runtime session. */
export interface SessionComposerDraft {
  text: string
  images: PromptImage[]
  /** Optional so drafts written before attachment chips existed still load. */
  files?: ComposerDraftFile[]
}

export type ComposerDrafts = Record<string, SessionComposerDraft>

export function draftHasContent(draft: SessionComposerDraft): boolean {
  return draft.text.length > 0 || draft.images.length > 0 || (draft.files?.length ?? 0) > 0
}

export function setComposerDraft(
  drafts: ComposerDrafts,
  sessionId: string,
  draft: SessionComposerDraft
): ComposerDrafts {
  if (!draftHasContent(draft)) {
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
