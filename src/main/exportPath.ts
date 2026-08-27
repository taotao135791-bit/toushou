/**
 * Default HTML export filename when the caller passes no outputPath:
 * omp-<session-slug|id8>-<YYYYMMDD-HHmm>.html
 */
export function defaultExportFileName(
  sessionTitle: string | undefined,
  sessionId: string,
  now: Date = new Date()
): string {
  const slug = (sessionTitle ?? '')
    .trim()
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  const base = slug || sessionId.slice(0, 8) || 'session'
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `omp-${base}-${stamp}.html`
}
