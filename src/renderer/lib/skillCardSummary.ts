/** Keep local installation notes out of the library card. The full file can still be opened. */
export function skillCardSummary(description: string): string {
  const summary = description.trim().replace(/^>\s*/, '')
  if (/^(?:name|author|description)\s*:/i.test(summary)) return ''
  if (/^(?:投手安装说明|安装说明|installation notes?|setup instructions?)\s*[：:]/i.test(summary)) return ''
  if (/(?:^|[\s`(])(?:\/(?:Users|home|private|Volumes)\/|[A-Za-z]:[\\/]|~\/)/.test(summary)) return ''
  return summary.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')
}
