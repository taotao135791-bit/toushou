/**
 * Runtime-backed select truth helpers. The current value the runtime reports
 * and the list of values the user may choose are DIFFERENT data. A current
 * value missing from the available set must still be displayed (marked
 * unavailable), never coerced to '' or a default — the UI shows what the
 * runtime actually is, not what the option list happens to contain.
 */

export interface CurrentValueState {
  /** The value the <select> must actually show ('' only for a true reset/auto). */
  value: string
  /** True when the current value is absent from the available options. */
  unavailable: boolean
}

/**
 * Classify the runtime's actual current value against the currently available
 * choices. An empty current value is a genuine automatic/reset state, never
 * "unavailable". A non-empty value that is not in the list is still the
 * truth — the caller must render it as a synthetic (unavailable) option.
 */
export function currentValueState(
  currentValue: string,
  availableValues: readonly string[]
): CurrentValueState {
  if (!currentValue) return { value: '', unavailable: false }
  if (availableValues.includes(currentValue)) return { value: currentValue, unavailable: false }
  return { value: currentValue, unavailable: true }
}