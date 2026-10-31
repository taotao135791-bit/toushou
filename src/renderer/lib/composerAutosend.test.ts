import { describe, expect, it } from 'vitest'
import { autosendForPrefill } from './composerAutosend'

describe('composer prefill auto-send decision', () => {
  it('clears a previously pending automatic send when an identical review-only draft arrives', () => {
    const text = 'review this draft'
    let pending = autosendForPrefill(text, true)
    expect(pending).toBe(text)
    pending = autosendForPrefill(text, false)
    expect(pending).toBeNull()
  })
})
