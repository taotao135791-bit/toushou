import { describe, it, expect, beforeEach } from 'vitest'
import {
  getCapabilities,
  noteSessionState,
  noteSubagentCapabilityOutcome,
  invalidateCliCache
} from '../omp/OmpCapabilities'
import { SessionState } from '../../shared/types'

describe('subagent capability preservation', () => {
  beforeEach(() => invalidateCliCache())

  it('a get_state refresh does not reset a proven supported capability', async () => {
    await getCapabilities()
    // A valid command + invalid child proves the command exists (supported).
    noteSubagentCapabilityOutcome('subagentMessages', { kind: 'command-error', error: 'not found' })
    expect((await getCapabilities()).subagentMessages).toBe('supported')

    noteSessionState({} as SessionState)
    noteSessionState({} as SessionState)
    noteSessionState({} as SessionState)
    expect((await getCapabilities()).subagentMessages).toBe('supported')
  })

  it('an unsupported verdict survives get_state', async () => {
    await getCapabilities()
    noteSubagentCapabilityOutcome('subagentMessages', { kind: 'unsupported', error: 'Unknown command: get_subagent_messages' })
    noteSessionState({} as SessionState)
    expect((await getCapabilities()).subagentMessages).toBe('unsupported')
  })
})
