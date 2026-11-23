/**
 * Renderer-side metric classification: re-exported from the shared safety
 * module so cards format and explain themselves with the SAME rules the
 * aggregation uses — no hand-copied regexes to drift.
 */
export { isBlockedUniqueUsersMetric, percentKind as isPercentMetric } from '@shared/boardMetricSafety'
