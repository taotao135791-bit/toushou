import { useEffect, useState } from 'react'

/** Cached currency → USD multipliers (Main fetches monthly; null offline).
 *  A FAILED fetch is never cached — the next mount retries, so a transient
 *  network blip at startup cannot hide conversions for the whole app run. */
let fxRatesPromise: Promise<Record<string, number> | null> | null = null

export function useFxRates(): Record<string, number> | null {
  const [rates, setRates] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    fxRatesPromise ??= window.electronAPI
      .fxRatesGet()
      .then((result) => {
        if (result === null) fxRatesPromise = null
        return result
      })
      .catch(() => {
        fxRatesPromise = null
        return null
      })
    void fxRatesPromise.then(setRates)
  }, [])
  return rates
}

/** "≈ $1,234.56" for a non-USD amount, or null when no rate is available. */
export function usdHint(amount: number, currency: string | null | undefined, rates: Record<string, number> | null): string | null {
  if (!currency || currency === 'USD' || !rates) return null
  const rate = rates[currency]
  if (!rate || !Number.isFinite(rate) || rate <= 0) return null
  const converted = amount * rate
  if (!Number.isFinite(converted)) return null
  return `≈ $${converted.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}
