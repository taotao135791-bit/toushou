/** Final path segment; tolerates trailing slashes ("" for empty input). */
export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? ''
}
