import { describe, it, expect } from 'vitest'
import { resolveSubprocessEnv } from './env'

describe('resolveSubprocessEnv', () => {
  it('inherit merges overrides over the host process.env', () => {
    const env = resolveSubprocessEnv('inherit', { FORCE_COLOR: '0', HOME: '/tmp/home' })
    expect(env.FORCE_COLOR).toBe('0')
    expect(env.HOME).toBe('/tmp/home')
    // Host environment keys remain visible in inherit mode.
    expect(Object.keys(env).length).toBeGreaterThan(2)
  })

  it('replace uses ONLY the overrides — never re-merges process.env', () => {
    const overrides = { HOME: '/tmp/home', PI_CODING_AGENT_DIR: '/tmp/agent' }
    const env = resolveSubprocessEnv('replace', overrides)
    expect(env).toEqual(overrides)
    // A real credential key present in the host must NOT leak through.
    if (process.env.OPENAI_API_KEY) {
      expect(env.OPENAI_API_KEY).toBeUndefined()
    }
  })

  it('replace defaults to an empty object when no overrides are given', () => {
    expect(resolveSubprocessEnv('replace')).toEqual({})
  })
})
