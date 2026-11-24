export const AUTO_COMPACT_THRESHOLD_DEFAULT = 80
export const AUTO_COMPACT_THRESHOLD_MIN = 50
export const AUTO_COMPACT_THRESHOLD_MAX = 95

export function isAutoCompactThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= AUTO_COMPACT_THRESHOLD_MIN && value <= AUTO_COMPACT_THRESHOLD_MAX
}

export function normalizeAutoCompactThreshold(value: unknown): number {
  return isAutoCompactThreshold(value) ? value : AUTO_COMPACT_THRESHOLD_DEFAULT
}
