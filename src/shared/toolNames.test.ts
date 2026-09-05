import { describe, expect, it } from 'vitest'
import { approvalToolNameFromTitle, normalizeToolCall } from './toolNames'

describe('normalizeToolCall', () => {
  it('remaps the xd:// write sentinel to the real extension tool name', () => {
    expect(normalizeToolCall('write', { path: 'xd://browser_navigate' })).toEqual({
      tool: 'browser_navigate',
      input: {}
    })
    expect(normalizeToolCall('write', { path: 'xd://browser_screenshot' })).toEqual({
      tool: 'browser_screenshot',
      input: {}
    })
  })

  it('preserves non-marker arguments and drops only the sentinel path', () => {
    expect(normalizeToolCall('write', { path: 'xd://feishu_doc_read', extra: 1 })).toEqual({
      tool: 'feishu_doc_read',
      input: { extra: 1 }
    })
  })

  it('passes native tool calls through untouched', () => {
    const bashInput = { command: 'ls -la' }
    expect(normalizeToolCall('bash', bashInput)).toEqual({ tool: 'bash', input: bashInput })
    // A native write to a file that merely starts with xd: is NOT a sentinel —
    // only exact `xd://<name>` paths are extension markers.
    expect(normalizeToolCall('write', { path: 'xd://nested/file.txt', content: 'x' })).toEqual({
      tool: 'write',
      input: { path: 'xd://nested/file.txt', content: 'x' }
    })
    expect(normalizeToolCall('write', { path: '/Users/me/file.txt', content: 'x' })).toEqual({
      tool: 'write',
      input: { path: '/Users/me/file.txt', content: 'x' }
    })
  })

  it('tolerates missing or malformed input', () => {
    expect(normalizeToolCall('write', undefined)).toEqual({ tool: 'write', input: undefined })
    expect(normalizeToolCall('write', { path: 'xd://' })).toEqual({ tool: 'write', input: { path: 'xd://' } })
    expect(normalizeToolCall('write', 'xd://browser_click')).toEqual({
      tool: 'write',
      input: 'xd://browser_click'
    })
  })
})

describe('approvalToolNameFromTitle', () => {
  it('extracts the extension tool name from a runtime approval title', () => {
    const title = 'Allow tool: write\nPath: xd://browser_click\nContent:\n{"ref": 1}'
    expect(approvalToolNameFromTitle(title)).toBe('browser_click')
  })

  it('matches single-line titles too', () => {
    expect(approvalToolNameFromTitle('Allow tool: write Path: xd://feishu_doc_read')).toBe(
      'feishu_doc_read'
    )
  })

  it('returns null for native tool prompts and malformed names', () => {
    expect(approvalToolNameFromTitle('Allow tool: bash\nCommand: ls -la')).toBeNull()
    expect(approvalToolNameFromTitle('Path: xd://nested/file.txt')).toBeNull()
    expect(approvalToolNameFromTitle('')).toBeNull()
  })
})
