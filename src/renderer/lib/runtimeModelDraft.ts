/**
 * A settings field has two distinct sources of truth while the form is open:
 * the runtime's last confirmed value and an explicit, unsaved user choice.
 * `null` means no local draft, whereas an empty string is a real draft that
 * asks the runtime to use its automatic default.
 */
export function resolveRuntimeSettingDraft(draft: string | null, runtimeValue: string): string {
  return draft ?? runtimeValue
}
