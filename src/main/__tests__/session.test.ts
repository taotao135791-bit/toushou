import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { OmpSession, OmpProcessLike } from '../omp/OmpSession'
import { Session, SessionEvent, SessionRuntimeState } from '../../shared/types'

/**
 * State-machine tests with a fake child process (EventEmitters for
 * stdout/stderr, mocks for stdin/kill) — no real pi is spawned.
 */

interface FakeProc {
  proc: OmpProcessLike
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { write: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
  emitter: EventEmitter
}

function makeFakeProc(): FakeProc {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = { write: vi.fn() }
  const kill = vi.fn()
  const emitter = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill })
  return { proc: emitter as unknown as OmpProcessLike, stdout, stderr, stdin, kill, emitter }
}

function makeSession() {
  const fake = makeFakeProc()
  const events: SessionEvent[] = []
  const gone: string[] = []
  const session: Session = { id: 's1', cwd: '/tmp/x', title: 'x', createdAt: 0, status: 'idle' }
  const s = new OmpSession(session, fake.proc, {
    label: 'pi',
    onEvent: (e) => events.push(e),
    onGone: () => gone.push('gone')
  })
  return { s, events, gone, fake }
}

/** Push complete JSONL frames through the fake stdout. */
function emitLines(fake: FakeProc, ...payloads: (Record<string, unknown> | string)[]): void {
  const text = payloads.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n')
  fake.stdout.emit('data', Buffer.from(text + '\n', 'utf8'))
}

type StatusEvent = Extract<SessionEvent, { type: 'status' }>

function statusEvents(events: SessionEvent[]): SessionRuntimeState[] {
  return events.filter((e): e is StatusEvent => e.type === 'status').map((e) => e.status)
}

describe('OmpSession lifecycle', () => {
  it('starts in idle and emits connected', () => {
    const { s, events } = makeSession()
    expect(s.runtimeState).toBe('idle')
    expect(events).toEqual([{ type: 'connected', sessionId: 's1' }])
  })

  it('transitions idle → working → idle on agent_start/agent_end', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' })
    expect(s.runtimeState).toBe('working')
    emitLines(fake, { type: 'agent_end' })
    expect(s.runtimeState).toBe('idle')
    expect(statusEvents(events)).toEqual(['working', 'idle'])
  })

  it('suppresses a duplicate agent_end while already idle', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' }, { type: 'agent_end' }, { type: 'agent_end' })
    expect(s.runtimeState).toBe('idle')
    expect(statusEvents(events)).toEqual(['working', 'idle'])
  })

  it('keeps a non-terminal agent_end (isTerminal: false) working', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' }, { type: 'agent_end', isTerminal: false })
    expect(s.runtimeState).toBe('working')
    expect(statusEvents(events)).toEqual(['working'])
    emitLines(fake, { type: 'agent_end' })
    expect(s.runtimeState).toBe('idle')
    expect(statusEvents(events)).toEqual(['working', 'idle'])
  })
})

describe('OmpSession extension UI', () => {
  it('cycles working → waiting_for_user → working → idle', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' })
    emitLines(fake, { type: 'extension_ui_request', id: 'x1', method: 'confirm', title: 'Proceed?' })
    expect(s.runtimeState).toBe('waiting_for_user')
    expect(events.filter((e) => e.type === 'ui_request')).toEqual([
      {
        type: 'ui_request',
        sessionId: 's1',
        id: 'x1',
        method: 'confirm',
        title: 'Proceed?',
        message: undefined,
        options: undefined,
        placeholder: undefined,
        prefill: undefined,
        timeout: undefined
      }
    ])
    // No status change while waiting — the renderer must stay busy.
    expect(statusEvents(events)).toEqual(['working'])

    expect(s.respondExtensionUi('x1', { confirmed: true })).toBe(true)
    expect(s.runtimeState).toBe('working')
    expect(fake.stdin.write).toHaveBeenCalledWith(
      '{"type":"extension_ui_response","id":"x1","confirmed":true}\n'
    )

    emitLines(fake, { type: 'agent_end' })
    expect(s.runtimeState).toBe('idle')
    expect(statusEvents(events)).toEqual(['working', 'idle'])
  })

  it('keeps a dialog pending when stdin rejects the response, then permits a retry', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' })
    emitLines(fake, { type: 'extension_ui_request', id: 'retry-1', method: 'confirm', title: 'Proceed?' })
    fake.stdin.write.mockImplementationOnce(() => {
      throw new Error('broken pipe')
    })

    expect(s.respondExtensionUi('retry-1', { confirmed: true })).toBe(false)
    expect(s.runtimeState).toBe('waiting_for_user')
    expect(s.respondExtensionUi('retry-1', { confirmed: true })).toBe(true)
    expect(s.runtimeState).toBe('working')
    expect(events.filter((event) => event.type === 'ui_request')).toHaveLength(1)
  })

  it('rejects duplicate extension dialog ids instead of enqueueing indistinguishable requests', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' })
    emitLines(fake, { type: 'extension_ui_request', id: 'same-id', method: 'confirm', title: 'First' })
    emitLines(fake, { type: 'extension_ui_request', id: 'same-id', method: 'confirm', title: 'Second' })

    expect(events.filter((event) => event.type === 'ui_request')).toHaveLength(1)
    expect(events).toContainEqual({
      type: 'error',
      sessionId: 's1',
      message: 'Extension sent a duplicate interactive request id; the duplicate was ignored.',
      recoverable: true
    })
    expect(s.respondExtensionUi('missing', { confirmed: true })).toBe(false)
  })

  it('turns unsupported extension UI calls into one visible diagnostic per method', () => {
    const { events, fake } = makeSession()
    emitLines(fake, { type: 'extension_ui_request', method: 'setWidget' })
    emitLines(fake, { type: 'extension_ui_request', method: 'setWidget' })
    expect(events.filter((event) => event.type === 'message')).toEqual([
      {
        type: 'message',
        sessionId: 's1',
        role: 'system',
        content: 'An installed extension requested unsupported host UI: setWidget.'
      }
    ])
  })
})

describe('OmpSession abort', () => {
  it('moves to aborting and converges at agent_end', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' })
    expect(s.abort()).toBe(true)
    expect(s.runtimeState).toBe('aborting')
    const written = fake.stdin.write.mock.calls.map((c) => String(c[0])).join('')
    expect(written).toContain('"type":"abort"')
    emitLines(fake, { type: 'agent_end' })
    expect(s.runtimeState).toBe('idle')
    expect(statusEvents(events)).toEqual(['working', 'idle'])
  })
})

describe('OmpSession error handling', () => {
  it('a rejected command never ends a running turn', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' })
    // e.g. a mid-stream prompt without steer/followUp is rejected while the
    // original turn keeps running — the turn must stay open.
    emitLines(fake, { type: 'response', id: 'orphan-1', command: 'prompt', success: false, error: 'Agent is already processing' })
    expect(s.runtimeState).toBe('working')
    expect(events).toContainEqual({
      type: 'error',
      sessionId: 's1',
      message: 'Agent is already processing',
      recoverable: true
    })
    expect(statusEvents(events)).toEqual(['working'])
    // The real terminal event still settles the turn afterwards.
    emitLines(fake, { type: 'agent_end' })
    expect(s.runtimeState).toBe('idle')
    expect(statusEvents(events)).toEqual(['working', 'idle'])
  })

  it('a rejected prompt ack while idle surfaces an error and re-settles idle', () => {
    const { s, events, fake } = makeSession()
    expect(s.sendPrompt('hello')).toBe(true)
    const written = JSON.parse(String(fake.stdin.write.mock.calls[0][0])) as { id: string }
    emitLines(fake, {
      type: 'response',
      id: written.id,
      command: 'prompt',
      success: false,
      error: 'No model configured'
    })
    // The renderer set busy optimistically when the prompt was sent; the
    // session must emit the idle transition that unblocks it.
    expect(events).toContainEqual({
      type: 'error',
      sessionId: 's1',
      message: 'No model configured',
      recoverable: true
    })
    expect(statusEvents(events)).toEqual(['idle'])
    expect(s.runtimeState).toBe('idle')
  })

  it('surfaces transport (oversize line) errors without dying', () => {
    const { s, events, fake } = makeSession()
    fake.stdout.emit('data', Buffer.alloc(17 * 1024 * 1024, 'a'))
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ recoverable: true })
    expect(s.runtimeState).toBe('idle')
    // Still functional afterwards: the LF resyncs framing.
    fake.stdout.emit('data', Buffer.from('tail of giant line\n' + JSON.stringify({ type: 'agent_start' }) + '\n'))
    expect(s.runtimeState).toBe('working')
  })
})

describe('OmpSession process exit / crash', () => {
  it('non-zero exit: failed → closed, stderr tail in the error, pending resolved null', async () => {
    const { s, events, gone, fake } = makeSession()
    fake.stderr.emit('data', Buffer.from('l1\nl2\nl3\nl4\n'))
    const query = s.query({ type: 'get_state' })
    fake.emitter.emit('exit', 1)
    await expect(query).resolves.toBeNull()
    expect(s.runtimeState).toBe('closed')
    const error = events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ recoverable: false })
    expect((error as { message: string }).message).toBe('omp exited with code 1\nl2\nl3\nl4')
    expect(events.filter((e) => e.type === 'closed')).toHaveLength(1)
    expect(gone).toEqual(['gone'])
  })

  it('clean exit (code 0): closed without an error event', () => {
    const { s, events, gone, fake } = makeSession()
    fake.emitter.emit('exit', 0)
    expect(s.runtimeState).toBe('closed')
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'closed')).toHaveLength(1)
    expect(gone).toEqual(['gone'])
  })

  it('spawn failure: failed → closed and a later exit is ignored', () => {
    const { s, events, gone, fake } = makeSession()
    fake.emitter.emit('error', new Error('spawn pi ENOENT'))
    expect(s.runtimeState).toBe('closed')
    expect(events).toContainEqual({
      type: 'error',
      sessionId: 's1',
      message: 'Failed to start pi: spawn pi ENOENT',
      recoverable: false
    })
    fake.emitter.emit('exit', -2)
    expect(events.filter((e) => e.type === 'closed')).toHaveLength(1)
    expect(gone).toEqual(['gone'])
  })

  it('processes a residual line at EOF before closing', () => {
    const { s, events, fake } = makeSession()
    fake.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'agent_start' }))) // no trailing LF
    fake.emitter.emit('exit', 0)
    expect(events).toContainEqual({ type: 'status', sessionId: 's1', status: 'working' })
    expect(s.runtimeState).toBe('closed')
  })
})

describe('OmpSession queries', () => {
  it('resolves a pending query with its matching response', async () => {
    const { s, fake } = makeSession()
    const query = s.query({ type: 'get_state' })
    const written = String(fake.stdin.write.mock.calls[0][0])
    const id = (JSON.parse(written) as { id: string }).id
    emitLines(fake, { type: 'response', id, command: 'get_state', success: true, data: { isStreaming: false } })
    const res = await query
    expect(res?.success).toBe(true)
    expect((res?.data as { isStreaming: boolean }).isStreaming).toBe(false)
  })

  it('kill() resolves pending queries with null, closes silently, ignores exit', async () => {
    const { s, events, gone, fake } = makeSession()
    const query = s.query({ type: 'get_state' })
    s.kill()
    await expect(query).resolves.toBeNull()
    expect(fake.kill).toHaveBeenCalled()
    expect(s.runtimeState).toBe('closed')
    // Renderer-initiated: no error/closed events.
    expect(events).toEqual([{ type: 'connected', sessionId: 's1' }])
    fake.emitter.emit('exit', null)
    expect(events).toEqual([{ type: 'connected', sessionId: 's1' }])
    expect(gone).toEqual(['gone'])
  })

  it('writes prompt commands with images and streaming behavior', () => {
    const { s, fake } = makeSession()
    expect(
      s.sendPrompt('hi', [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], 'steer')
    ).toBe(true)
    const written = JSON.parse(String(fake.stdin.write.mock.calls[0][0])) as Record<string, unknown>
    expect(written).toMatchObject({
      type: 'prompt',
      message: 'hi',
      streamingBehavior: 'steer'
    })
    expect(written.images).toEqual([{ type: 'image', data: 'AA==', mimeType: 'image/png' }])
  })
})

describe('OmpSession assistant text tracking', () => {
  it('accumulates deltas per turn and finalizes at agent_end', () => {
    const { s, fake } = makeSession()
    emitLines(
      fake,
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } },
      { type: 'agent_end' }
    )
    expect(s.lastAssistantText).toBe('Hello world')
  })
})

const READY = {
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864
}

describe('OmpSession bootstrap & negotiation', () => {
  it('legacy profile: no ready frame, first event activates v1', () => {
    const { s, events, fake } = makeSession()
    emitLines(fake, { type: 'agent_start' })
    expect(s.handshakeOutcome).toEqual({ profile: 'legacy', protocolVersion: 1 })
    expect(events).toContainEqual({ type: 'status', sessionId: 's1', status: 'working' })
  })

  it('current profile: ready → negotiate_protocol written → v2 on success', () => {
    const handshakes: string[] = []
    const fake2 = makeFakeProc()
    const s2 = new OmpSession(
      { id: 's2', cwd: '/tmp/x', title: 'x', createdAt: 0, status: 'idle' },
      fake2.proc,
      {
        label: 'omp',
        onEvent: () => {},
        onHandshake: (o) => handshakes.push(`${o.profile}:v${o.protocolVersion}`)
      }
    )
    fake2.stdout.emit('data', Buffer.from(JSON.stringify(READY) + '\n'))
    // The session wrote a negotiate_protocol command whose id matches what
    // the handshake expects.
    const written = fake2.stdin.write.mock.calls.map((c) => String(c[0])).join('')
    const match = written.match(/\{"id":"([^"]+)","type":"negotiate_protocol","protocolVersion":2\}/)
    expect(match).toBeTruthy()
    const id = match![1]
    fake2.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'response',
          id,
          command: 'negotiate_protocol',
          success: true,
          data: { protocolVersion: 2 }
        }) + '\n'
      )
    )
    expect(s2.handshakeOutcome?.protocolVersion).toBe(2)
    expect(s2.handshakeOutcome?.maxFrameBytes).toBe(1048576)
    expect(handshakes).toEqual(['current:v2'])
  })

  it('unsupported runtime: compatibility error then closed, process killed', () => {
    const fake = makeFakeProc()
    const events: SessionEvent[] = []
    const gone: string[] = []
    const s = new OmpSession(
      { id: 's3', cwd: '/tmp/x', title: 'x', createdAt: 0, status: 'idle' },
      fake.proc,
      { label: 'omp', onEvent: (e) => events.push(e), onGone: () => gone.push('gone') }
    )
    fake.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ ...READY, supportedProtocolVersions: [3] }) + '\n')
    )
    const error = events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ recoverable: false })
    expect((error as { message: string }).message).toContain('Runtime supported RPC versions: 3')
    expect((error as { message: string }).message).toContain('GUI supported RPC versions: 1, 2')
    expect(s.runtimeState).toBe('closed')
    expect(fake.kill).toHaveBeenCalled()
    expect(gone).toEqual(['gone'])
  })

  it('rejected negotiation falls back to v1 and keeps working', () => {
    const fake = makeFakeProc()
    const s = new OmpSession(
      { id: 's4', cwd: '/tmp/x', title: 'x', createdAt: 0, status: 'idle' },
      fake.proc,
      { label: 'omp', onEvent: () => {} }
    )
    fake.stdout.emit('data', Buffer.from(JSON.stringify(READY) + '\n'))
    const written = fake.stdin.write.mock.calls.map((c) => String(c[0])).join('')
    const id = written.match(/"id":"([^"]+)","type":"negotiate_protocol"/)![1]
    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'response',
          id,
          command: 'negotiate_protocol',
          success: false,
          error: 'Unsupported RPC protocol version: 2'
        }) + '\n'
      )
    )
    expect(s.handshakeOutcome?.protocolVersion).toBe(1)
    // Session still fully functional in v1.
    fake.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'agent_start' }) + '\n'))
    expect(s.runtimeState).toBe('working')
  })

  it('rpc_chunk before negotiation is a transport error, not data', () => {
    const { events, fake } = makeSession()
    emitLines(fake, {
      type: 'rpc_chunk',
      chunkId: 'rpc-1',
      index: 0,
      count: 4,
      byteLength: 1048576,
      data: 'AAAA'
    })
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ recoverable: true })
  })

  it('reassembles rpc_chunk frames into a logical response after v2', async () => {
    const fake = makeFakeProc()
    const s = new OmpSession(
      { id: 's5', cwd: '/tmp/x', title: 'x', createdAt: 0, status: 'idle' },
      fake.proc,
      { label: 'omp', onEvent: () => {} }
    )
    fake.stdout.emit('data', Buffer.from(JSON.stringify(READY) + '\n'))
    const written = fake.stdin.write.mock.calls.map((c) => String(c[0])).join('')
    const negId = written.match(/"id":"([^"]+)","type":"negotiate_protocol"/)![1]
    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'response',
          id: negId,
          command: 'negotiate_protocol',
          success: true,
          data: { protocolVersion: 2 }
        }) + '\n'
      )
    )

    // Now query and answer with a chunked response (>1 MiB logical payload).
    const query = s.query({ type: 'get_messages' })
    const qWritten = fake.stdin.write.mock.calls.map((c) => String(c[0])).join('')
    const qid = qWritten.match(/"id":"([^"]+)","type":"get_messages"/)![1]
    const payload = Buffer.from(
      JSON.stringify({
        type: 'response',
        id: qid,
        command: 'get_messages',
        success: true,
        data: { messages: ['B'.repeat(1_100_000)] }
      }),
      'utf8'
    )
    const chunkSize = 256 * 1024
    const count = Math.ceil(payload.length / chunkSize)
    const lines: string[] = []
    for (let index = 0; index < count; index++) {
      lines.push(
        JSON.stringify({
          type: 'rpc_chunk',
          chunkId: 'rpc-9',
          index,
          count,
          byteLength: payload.length,
          data: payload.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64')
        })
      )
    }
    fake.stdout.emit('data', Buffer.from(lines.join('\n') + '\n'))
    const res = await query
    expect(res?.success).toBe(true)
    expect((res?.data as { messages: string[] }).messages[0]).toHaveLength(1_100_000)
  })

  it('process exit mid-chunk rejects pending queries and closes', async () => {
    const fake = makeFakeProc()
    const events: SessionEvent[] = []
    const s = new OmpSession(
      { id: 's6', cwd: '/tmp/x', title: 'x', createdAt: 0, status: 'idle' },
      fake.proc,
      { label: 'omp', onEvent: (e) => events.push(e) }
    )
    fake.stdout.emit('data', Buffer.from(JSON.stringify(READY) + '\n'))
    const written = fake.stdin.write.mock.calls.map((c) => String(c[0])).join('')
    const negId = written.match(/"id":"([^"]+)","type":"negotiate_protocol"/)![1]
    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'response',
          id: negId,
          command: 'negotiate_protocol',
          success: true,
          data: { protocolVersion: 2 }
        }) + '\n'
      )
    )
    const query = s.query({ type: 'get_messages' })
    // Start a chunk sequence but never finish it.
    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'rpc_chunk',
          chunkId: 'rpc-1',
          index: 0,
          count: 4,
          byteLength: 1048576,
          data: Buffer.alloc(1024).toString('base64')
        }) + '\n'
      )
    )
    fake.emitter.emit('exit', 1)
    await expect(query).resolves.toBeNull()
    expect(s.runtimeState).toBe('closed')
  })
})

describe('OmpSession prompt lifecycle (current runtime)', () => {
  function currentSession() {
    const fake = makeFakeProc()
    const events: SessionEvent[] = []
    const s = new OmpSession(
      { id: 's7', cwd: '/tmp/x', title: 'x', createdAt: 0, status: 'idle' },
      fake.proc,
      { label: 'omp', onEvent: (e) => events.push(e) }
    )
    fake.stdout.emit('data', Buffer.from(JSON.stringify(READY) + '\n'))
    return { s, events, fake }
  }

  function lastPromptId(fake: FakeProc): string {
    const written = fake.stdin.write.mock.calls.map((c) => String(c[0])).join('')
    return written.match(/"id":"([^"]+)","type":"prompt"/)![1]
  }

  it('local-only prompt ack (agentInvoked:false) settles idle — no agent events', () => {
    const { s, events, fake } = currentSession()
    expect(s.sendPrompt('/model')).toBe(true)
    const id = lastPromptId(fake)
    emitLines(
      fake,
      { type: 'command_output', text: 'Current model: deepseek/x' },
      { type: 'response', id, command: 'prompt', success: true, data: { agentInvoked: false } }
    )
    // The output is visible and the session released its (optimistic) busy.
    expect(events).toContainEqual({
      type: 'message',
      sessionId: 's7',
      role: 'system',
      content: 'Current model: deepseek/x'
    })
    expect(statusEvents(events)).toEqual(['idle'])
    expect(s.runtimeState).toBe('idle')
  })

  it('agent prompt ack (data null) waits for the real agent events', () => {
    const { s, events, fake } = currentSession()
    s.sendPrompt('hello')
    const id = lastPromptId(fake)
    emitLines(fake, { type: 'response', id, command: 'prompt', success: true, data: null })
    // No premature idle — the agent lifecycle drives the state.
    expect(statusEvents(events)).toEqual([])
    emitLines(fake, { type: 'agent_start' }, { type: 'agent_end' })
    expect(statusEvents(events)).toEqual(['working', 'idle'])
  })

  it('deferred prompt_result (agentInvoked:false) settles idle', () => {
    const { s, events, fake } = currentSession()
    s.sendPrompt('/compact')
    const id = lastPromptId(fake)
    emitLines(
      fake,
      { type: 'response', id, command: 'prompt', success: true, data: null },
      { type: 'prompt_result', id, agentInvoked: false }
    )
    expect(statusEvents(events)).toEqual(['idle'])
    expect(s.runtimeState).toBe('idle')
  })

  it('mid-stream local command does not disturb the running turn', () => {
    const { s, events, fake } = currentSession()
    s.sendPrompt('count to 30')
    const id = lastPromptId(fake)
    emitLines(fake, { type: 'response', id, command: 'prompt', success: true, data: null })
    emitLines(fake, { type: 'agent_start' })
    s.sendPrompt('/model')
    const id2 = lastPromptId(fake)
    emitLines(
      fake,
      { type: 'command_output', text: 'Current model: x' },
      { type: 'response', id: id2, command: 'prompt', success: true, data: { agentInvoked: false } }
    )
    // Still working — no spurious idle in the middle of the turn.
    expect(statusEvents(events)).toEqual(['working'])
    expect(s.runtimeState).toBe('working')
    emitLines(fake, { type: 'agent_end' })
    expect(statusEvents(events)).toEqual(['working', 'idle'])
  })

  it('mid-stream prompt rejection surfaces an error but keeps the turn open', () => {
    const { s, events, fake } = currentSession()
    s.sendPrompt('long task')
    const id = lastPromptId(fake)
    emitLines(fake, { type: 'response', id, command: 'prompt', success: true, data: null })
    emitLines(fake, { type: 'agent_start' })
    s.sendPrompt('another one')
    const id2 = lastPromptId(fake)
    // The runtime acks first, then rejects with a second response frame.
    emitLines(fake, { type: 'response', id: id2, command: 'prompt', success: true, data: null })
    emitLines(fake, {
      type: 'response',
      id: id2,
      command: 'prompt',
      success: false,
      error: 'Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.'
    })
    expect(events).toContainEqual({
      type: 'error',
      sessionId: 's7',
      message:
        'Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.',
      recoverable: true
    })
    expect(s.runtimeState).toBe('working')
    expect(statusEvents(events)).toEqual(['working'])
  })

  it('extension_ui cancel drops the pending dialog', () => {
    const { s, events, fake } = currentSession()
    emitLines(fake, { type: 'agent_start' })
    emitLines(fake, { type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'Sure?' })
    expect(events.some((e) => e.type === 'ui_request' && e.id === 'd1')).toBe(true)
    emitLines(fake, { type: 'extension_ui_request', id: 'c1', method: 'cancel', targetId: 'd1' })
    expect(events).toContainEqual({ type: 'ui_cancel', sessionId: 's7', id: 'd1' })
    // The dismissed dialog resolves as cancelled; the turn continues.
    expect(s.runtimeState).toBe('working')
  })

  it('open_url frames reach the onOpenUrl callback', () => {
    const fake = makeFakeProc()
    const opened: string[] = []
    const s = new OmpSession(
      { id: 's8', cwd: '/tmp/x', title: 'x', createdAt: 0, status: 'idle' },
      fake.proc,
      {
        label: 'omp',
        onEvent: () => {},
        onOpenUrl: (url, launchUrl) => opened.push(launchUrl ?? url)
      }
    )
    void s
    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'extension_ui_request',
          id: 'o1',
          method: 'open_url',
          url: 'https://provider.example/auth?code_challenge=abc',
          launchUrl: 'http://127.0.0.1:5111/launch'
        }) + '\n'
      )
    )
    expect(opened).toEqual(['http://127.0.0.1:5111/launch'])
  })
})
