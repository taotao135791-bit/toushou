/** Every incoming prefill replaces the previous pending auto-send decision. */
export function autosendForPrefill(text: string, autosend: boolean): string | null {
  return autosend ? text : null
}
