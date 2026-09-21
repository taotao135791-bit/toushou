import { describe, expect, it } from 'vitest'
import { configGet } from './OmpConfigCli'

type Run = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>

function entryJson(value: unknown): string {
  return JSON.stringify({ key: 'k', value, type: 'string' })
}

describe('configGet transient-failure retry', () => {
  it('retries once when the CLI run fails, then succeeds', async () => {
    let calls = 0
    const run: Run = async () => {
      calls += 1
      return calls === 1 ? { ok: false, stdout: '', stderr: '' } : { ok: true, stdout: entryJson('high'), stderr: '' }
    }
    const entry = await configGet(run, 'k')
    expect(calls).toBe(2)
    expect(entry?.value).toBe('high')
  })

  it('does not retry a genuinely unset key (entry present, no value)', async () => {
    let calls = 0
    const run: Run = async () => {
      calls += 1
      return { ok: true, stdout: JSON.stringify({ key: 'k', type: 'string' }), stderr: '' }
    }
    const entry = await configGet(run, 'k')
    expect(calls).toBe(1)
    expect(entry?.value).toBeUndefined()
  })

  it('returns null after two failed attempts', async () => {
    let calls = 0
    const run: Run = async () => {
      calls += 1
      return { ok: false, stdout: '', stderr: '' }
    }
    const entry = await configGet(run, 'k')
    expect(calls).toBe(2)
    expect(entry).toBeNull()
  })
})
