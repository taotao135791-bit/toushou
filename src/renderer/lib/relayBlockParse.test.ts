import { describe, expect, it } from 'vitest'
import { parseRelayBlock } from './relayBlockParse'

describe('parseRelayBlock', () => {
  it('parses a bare newapi JSON block', () => {
    expect(
      parseRelayBlock('{"url":"https://relay.example.com/v1","key":"sk-abc","models":["gpt-4o-mini","claude-3"]}')
    ).toEqual({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-abc', model: 'gpt-4o-mini', protocol: 'openai' })
  })

  it('parses a fenced block with alias keys and detects anthropic', () => {
    expect(
      parseRelayBlock('```json\n{"api_base":"https://api.anthropic.com/v1","api_token":"sk-ant-zzz","model":"claude-x"}\n```')
    ).toEqual({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-zzz', model: 'claude-x', protocol: 'anthropic' })
  })

  it('sniffs anthropic from an sk-ant key even without an anthropic url', () => {
    const result = parseRelayBlock('{"base_url":"https://relay.example.com","api_key":"sk-ant-1"}')
    expect(result?.protocol).toBe('anthropic')
  })

  it('returns null for prose without JSON or blocks missing both url and key', () => {
    expect(parseRelayBlock('帮我配一下中转站')).toBeNull()
    expect(parseRelayBlock('{"note":"no credentials"}')).toBeNull()
  })
})
