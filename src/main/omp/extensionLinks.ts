import { safeExternalUrl } from '../navigation'

/**
 * Turn an extension's URL request into a plain, user-mediated system message.
 * The session host never opens extension URLs by itself: the user must choose
 * the rendered link, which the renderer sends to the system browser through
 * the separately validated external-link IPC.
 */

/**
 * Extension URLs are stricter than ordinary user-authored Markdown links:
 * HTTPS is always allowed, while HTTP is reserved for loopback OAuth flows.
 * Reuse the browser-boundary validator so parser and click-time policy cannot
 * disagree about credentials, control characters, or normalization.
 */
export function safeExtensionExternalUrl(value: unknown): string | null {
  const normalized = safeExternalUrl(value)
  if (!normalized) return null
  const url = new URL(normalized)
  if (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))
  ) {
    return normalized
  }
  return null
}

/** Render extension-provided prose as an indented code block, never Markdown. */
function markdownPlainText(value: string): string {
  return value
    .slice(0, 16_000)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

export function extensionExternalLinkMessage(
  url: string,
  launchUrl?: string,
  instructions?: string
): string | null {
  const target = safeExtensionExternalUrl(launchUrl ?? url)
  if (!target) return null

  const parsed = new URL(target)
  const host = parsed.hostname || 'external link'
  const note = instructions?.trim()
    ? `Extension notes:\n\n${markdownPlainText(instructions.trim())}\n\n`
    : ''

  // URLs may legally contain Markdown delimiter characters. Percent-encode
  // them in the destination so an extension cannot terminate this link early
  // or append a second Markdown construct to the transcript.
  const markdownTarget = target.replace(/[()[\]]/g, (character) => {
    switch (character) {
      case '(':
        return '%28'
      case ')':
        return '%29'
      case '[':
        return '%5B'
      case ']':
        return '%5D'
      default:
        return character
    }
  })

  return (
    `${note}An installed extension requested an external link. ` +
    `Open it only if you trust the extension.\n\n[Open ${host}](${markdownTarget})`
  )
}
