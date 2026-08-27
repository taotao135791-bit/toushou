import { describe, it, expect } from 'vitest'
import { isTrustedUrl } from '../installer'

describe('installer trust boundary', () => {
  it('accepts the official installer host', () => {
    expect(isTrustedUrl('https://omp.sh/install')).toBe(true)
    expect(isTrustedUrl('https://get.omp.sh/install.sh')).toBe(true)
  })

  it('accepts official GitHub hosts', () => {
    expect(isTrustedUrl('https://github.com/oh-my-pi/pi/releases/download/x/install.sh')).toBe(true)
    expect(isTrustedUrl('https://raw.githubusercontent.com/oh-my-pi/pi/main/install.sh')).toBe(true)
    expect(isTrustedUrl('https://github-releases.githubusercontent.com/x/y')).toBe(true)
  })

  it('rejects non-https schemes', () => {
    expect(isTrustedUrl('http://omp.sh/install')).toBe(false)
    expect(isTrustedUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects untrusted hosts', () => {
    expect(isTrustedUrl('https://evil.example.com/install.sh')).toBe(false)
    expect(isTrustedUrl('https://omp.sh.evil.com/install')).toBe(false)
    expect(isTrustedUrl('https://notgithub.com/x')).toBe(false)
  })

  it('rejects malformed URLs', () => {
    expect(isTrustedUrl('not a url')).toBe(false)
  })
})
