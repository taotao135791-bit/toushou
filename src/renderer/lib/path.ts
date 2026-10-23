/** Final path segment; tolerates trailing slashes and Windows separators
 * ("" for empty input). Windows cwd strings arrive backslash-separated — a
 * '/'-only split returned the whole path, which silently disabled the
 * session auto-naming guard and the title-downgrade protections. */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ''
}
