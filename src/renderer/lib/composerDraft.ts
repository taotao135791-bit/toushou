import type { ComposerDraftFile, ComposerFileKind, ComposerDrafts, Session, SessionComposerDraft } from '@shared/types'

export type { ComposerDraftFile, ComposerFileKind, ComposerDrafts, SessionComposerDraft }

/**
 * Draft key for the not-yet-created conversation (composer with no session).
 * A sentinel key survives session-list pruning so an unsent new-chat draft
 * stays across page switches, app restarts and the first send attempt.
 */
export const NEW_CHAT_DRAFT_KEY = '__new-chat__'
const HISTORY_DRAFT_PREFIX = 'history:'

export function historyComposerDraftKey(uuid: string): string {
  return `${HISTORY_DRAFT_PREFIX}${uuid}`
}

export function sessionComposerDraftKey(session: Pick<Session, 'id' | 'draftSessionUuid'>): string {
  return session.draftSessionUuid ? historyComposerDraftKey(session.draftSessionUuid) : session.id
}

/** A runtime drop staged as an attachment chip (renderer representation). */
export interface DroppedAttachment {
  id: string
  /** Absolute filesystem path; falls back to the display name for virtual files. */
  path: string
  name: string
  isDirectory: boolean
  kind: ComposerFileKind
}

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

/**
 * Drop only transient drafts. Durable conversations often move out of the
 * live registry when archived, closed, or restarted.
 */
export function pruneComposerDrafts(drafts: ComposerDrafts, sessionIds: Set<string>): ComposerDrafts {
  const next = Object.fromEntries(
    Object.entries(drafts).filter(([key]) => key === NEW_CHAT_DRAFT_KEY || key.startsWith(HISTORY_DRAFT_PREFIX) || sessionIds.has(key))
  )
  return Object.keys(next).length === Object.keys(drafts).length ? drafts : next
}
