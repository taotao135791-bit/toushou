import { describe, expect, it } from 'vitest'
import { extensionExternalLinkMessage, safeExtensionExternalUrl } from './extensionLinks'

describe('extension external links', () => {
  it('requires an explicit, safe Markdown link instead of opening the URL itself', () => {
    expect(
      extensionExternalLinkMessage('https://auth.example.com/login', undefined, 'Sign in to continue')
    ).toBe(
      'Extension notes:\n\n    Sign in to continue\n\nAn installed extension requested an external link. ' +
        'Open it only if you trust the extension.\n\n[Open auth.example.com](https://auth.example.com/login)'
    )
  })

  it('renders extension-provided prose as code so it cannot inject another Markdown link', () => {
    expect(
      extensionExternalLinkMessage('https://auth.example.com/login', undefined, '[misleading](https://evil.example)')
    ).toContain('    [misleading](https://evil.example)')
  })

  it('allows loopback OAuth launches but rejects arbitrary HTTP and non-web schemes', () => {
    expect(extensionExternalLinkMessage('https://auth.example.com', 'http://127.0.0.1:4111/callback')).toContain(
      '[Open 127.0.0.1](http://127.0.0.1:4111/callback)'
    )
    expect(extensionExternalLinkMessage('http://example.com')).toBeNull()
    expect(extensionExternalLinkMessage('file:///etc/passwd')).toBeNull()
  })

  it('shares browser URL validation and cannot let a URL inject extra Markdown', () => {
    expect(safeExtensionExternalUrl('https://user:secret@example.com')).toBeNull()
    expect(safeExtensionExternalUrl(' https://example.com')).toBeNull()
    expect(safeExtensionExternalUrl('http://example.com')).toBeNull()
    expect(extensionExternalLinkMessage('https://example.com/one) [bad](https://evil.example)')).toContain(
      '(https://example.com/one%29%20%5Bbad%5D%28https://evil.example%29)'
    )
  })
})
