import { PromptImage } from '@shared/types'
import type { I18nKey } from '../i18n'

export type SteerSource = 'composer' | 'queue'

export function steerFailureKey(source: SteerSource): I18nKey {
  return source === 'queue' ? 'chat.steerQueueFailed' : 'chat.steerComposerFailed'
}

export type SteerDispatchResult =
  | { source: SteerSource; ok: true }
  | { source: SteerSource; ok: false; error?: unknown }

/**
 * Normalize the renderer's only Steer acknowledgement boundary.
 * Transcript and trajectory callers should act only after this returns ok.
 */
export async function dispatchSteer({
  sessionId,
  text,
  images,
  source,
  steer
}: {
  sessionId: string
  text: string
  images?: PromptImage[]
  source: SteerSource
  steer: (sessionId: string, text: string, images?: PromptImage[]) => Promise<boolean>
}): Promise<SteerDispatchResult> {
  try {
    const accepted = await steer(sessionId, text, images)
    return accepted ? { source, ok: true } : { source, ok: false }
  } catch (error) {
    return { source, ok: false, error }
  }
}
