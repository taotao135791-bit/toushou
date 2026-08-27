import { ExtensionUiAnswer, LoginAnswer } from '../shared/types'

/** Matches the maximum extension-editor payload accepted by OmpProtocol. */
export const MAX_UI_ANSWER_VALUE_LENGTH = 64 * 1024

/**
 * The extension and login flows use the same three answer variants. Validate
 * the exact discriminated shape at the IPC boundary rather than accepting an
 * object that merely happens to contain one plausible property.
 */
export function isUiAnswer(value: unknown): value is ExtensionUiAnswer & LoginAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1) return false
  switch (keys[0]) {
    case 'cancelled':
      return record.cancelled === true
    case 'confirmed':
      return typeof record.confirmed === 'boolean'
    case 'value':
      return typeof record.value === 'string' && record.value.length <= MAX_UI_ANSWER_VALUE_LENGTH
    default:
      return false
  }
}
