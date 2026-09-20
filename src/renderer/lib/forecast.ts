/**
 * In-process forecast for daily board series — a small robust model with no
 * external dependency and no network access, so a chart widget can draw a
 * projection band entirely from data it already holds.
 *
 * Model (robust OLS):
 *   1. Keep only finite numeric values (non-numeric entries are dropped).
 *   2. Fit on the last N = min(14, len) points; a week-and-a-half window
 *      tracks recent pacing without letting a month-old regime dominate.
 *   3. Damp outliers by clipping window values to [p10, p90] (linear
 *      interpolated percentiles of the window) BEFORE the least-squares fit,
 *      so a single spend spike bends neither the slope nor the band.
 *   4. Ordinary least squares y = slope·x + intercept over window index
 *      x = 0..n-1; residuals give sigma = sqrt(Σr²/n).
 *   5. Each horizon step k = 1..horizon predicts at x = n-1+k with an ~80%
 *      band lo = pred - 1.28σ, hi = pred + 1.28σ (1.28 ≈ the 80% two-sided
 *      z-score). A constant series degenerates to sigma = 0, floored to a
 *      scale-relative epsilon so flat series stay visually flat.
 *   6. Labels continue the last point's date daily (YYYY-MM-DD). When the
 *      last label is not a parseable date the points fall back to "+k d".
 */
import { parseDateString } from '../../shared/datasets'

/** One projected point: the point value plus its ~80% confidence band. */
export interface ForecastPoint {
  /** Next date after the series ends (YYYY-MM-DD), or a "+k d" fallback. */
  label: string
  /** Point prediction for that day. */
  value: number
  /** Always true — lets charts style projection points apart from history. */
  forecast: true
  /** Lower band edge: value - 1.28 · sigma. */
  lo: number
  /** Upper band edge: value + 1.28 · sigma. */
  hi: number
}

/** Input point shape shared with chart/counter series ({ label, value }). */
export interface ForecastSeriesPoint {
  label: string
  value: number
}

/** Fewer valid points than this cannot support a slope estimate. */
const MIN_POINTS = 4
/** Fit window: at most the last two weeks of daily points. */
const FIT_WINDOW = 14
/** Two-sided z-score for an ~80% confidence band. */
const Z_80 = 1.28
/** Constant-series sigma floor: 1e-6 of the level (never below 1e-9). */
const SIGMA_FLOOR_REL = 1e-6
const SIGMA_FLOOR_ABS = 1e-9

/** Linear-interpolated percentile of an ascending-sorted array. */
function percentile(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** `anchor` (YYYY-MM-DD) shifted forward by `days`; null if unparseable. */
export function nextDateLabel(anchor: string, days: number): string | null {
  const normalized = parseDateString(anchor)
  if (!normalized) return null
  const [y, m, d] = normalized.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Project the next `horizon` daily points of a chronological series. Returns
 * [] for fewer than 4 valid points or a non-positive horizon; pure — the
 * input is never mutated and the same input always yields the same output.
 */
export function forecastSeries(
  points: ForecastSeriesPoint[],
  horizon: number
): ForecastPoint[] {
  const steps = Number.isFinite(horizon) ? Math.floor(horizon) : 0
  if (steps <= 0) return []

  const series = (Array.isArray(points) ? points : []).filter(
    (p): p is ForecastSeriesPoint =>
      !!p && typeof p.value === 'number' && Number.isFinite(p.value)
  )
  if (series.length < MIN_POINTS) return []

  const window = series.slice(-Math.min(FIT_WINDOW, series.length))
  const values = window.map((p) => p.value)

  // Outlier damping: clip to the window's [p10, p90] before fitting.
  const sorted = [...values].sort((a, b) => a - b)
  const p10 = percentile(sorted, 0.1)
  const p90 = percentile(sorted, 0.9)
  const damped = values.map((v) => Math.min(Math.max(v, p10), p90))

  // OLS over window index x = 0..n-1 (n >= 4, so sxx > 0).
  const n = damped.length
  const xBar = (n - 1) / 2
  const yBar = damped.reduce((sum, v) => sum + v, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (i - xBar) * (damped[i] - yBar)
    sxx += (i - xBar) * (i - xBar)
  }
  const slope = sxy / sxx
  const intercept = yBar - slope * xBar

  // Residual std-dev around the fit (population form, matches the band's
  // heuristic intent); floored so constant series stay flat, not exactly 0.
  let rss = 0
  for (let i = 0; i < n; i++) {
    const residual = damped[i] - (slope * i + intercept)
    rss += residual * residual
  }
  const sigma = Math.max(
    Math.sqrt(rss / n),
    Math.abs(yBar) * SIGMA_FLOOR_REL,
    SIGMA_FLOOR_ABS
  )

  const anchor = nextDateLabel(
    typeof series[series.length - 1].label === 'string' ? series[series.length - 1].label : '',
    0
  )

  const out: ForecastPoint[] = []
  for (let k = 1; k <= steps; k++) {
    const value = slope * (n - 1 + k) + intercept
    out.push({
      label: anchor ? (nextDateLabel(anchor, k) as string) : `+${k} d`,
      value,
      forecast: true,
      lo: value - Z_80 * sigma,
      hi: value + Z_80 * sigma
    })
  }
  return out
}
