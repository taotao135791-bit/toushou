/** Return a compact filename for a full export path without exposing the path in the UI. */
export function exportFilename(savedPath: string): string {
  const normalized = savedPath.replaceAll('\\', '/')
  return normalized.split('/').pop()?.trim() || savedPath
}

