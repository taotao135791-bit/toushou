export function shortcutPlatform(): string {
  if (typeof window === 'undefined') return ''
  return window.electronAPI?.platform || platformFromBrowser(navigator.platform || navigator.userAgent)
}

/** Browser preview fallback; packaged builds use the actual Electron platform. */
export function platformFromBrowser(identifier: string): string {
  if (/\b(?:Windows|Win(?:32|64|CE)?)\b/i.test(identifier)) return 'win32'
  if (/Mac|iP(hone|ad|od)/i.test(identifier)) return 'darwin'
  if (/Linux/i.test(identifier)) return 'linux'
  return ''
}

export function hasPrimaryModifier(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>, platform = shortcutPlatform()): boolean {
  return platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function composerHistoryCommand(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>,
  platform = shortcutPlatform()
): 'undo' | 'redo' | undefined {
  if (!hasPrimaryModifier(event, platform) || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (platform === 'win32' && key === 'y' && !event.shiftKey) return 'redo'
}
