import { describe, expect, it } from 'vitest'
import { redactSecrets } from './logger'

describe('redactSecrets', () => {
  it('redacts Bearer tokens in SDK error dumps', () => {
    const line =
      '{"headers":{"Authorization":"Bearer t-g10495cFRBUVJ7GBZERFRINBCUHQQ2LMVJ3XRCXU"},"url":"https://open.feishu.cn"}'
    expect(redactSecrets(line)).not.toContain('t-g10495')
    expect(redactSecrets(line)).toContain('Bearer ***')
    expect(redactSecrets(line)).toContain('open.feishu.cn')
  })

  it('redacts Feishu-shaped tokens and JSON credential fields', () => {
    expect(redactSecrets('token t-g104abcdef1234567890 leaked')).not.toContain('g104abcdef')
    expect(redactSecrets('user token u-cQK2abcd1234 leaked')).not.toContain('cQK2abcd')
    expect(redactSecrets('{"user_access_token":"u-verysecrettoken"}')).toBe(
      '{"user_access_token":"***"}'
    )
    expect(redactSecrets('{"app_secret":"supersecretvalue"}')).toBe('{"app_secret":"***"}')
  })

  it('leaves ordinary content untouched', () => {
    const line = '[2026-09-05T05:05:15.850Z] [INFO] [app] starting TouShou 0.5.1 (darwin)'
    expect(redactSecrets(line)).toBe(line)
  })
})
