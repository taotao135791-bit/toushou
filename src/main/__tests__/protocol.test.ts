import { describe, it, expect } from 'vitest'
import { parseRpcLine, extensionUiCancel, extensionUiResponse } from '../omp/OmpProtocol'

describe('parseRpcLine', () => {
  it('reports failed responses as command_failed (never an error event)', () => {
    const line = JSON.stringify({
      type: 'response',
      id: 'r1',
      command: 'prompt',
      success: false,
      error: 'model not configured'
    })
    // The session decides whether a failure is user-visible; the parser
    // only classifies, so a rejected command can never kill a running turn.
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'command_failed',
      id: 'r1',
      command: 'prompt',
      message: 'model not configured',
      code: undefined
    })
  })

  it('ignores successful responses', () => {
    const line = JSON.stringify({ type: 'response', command: 'prompt', success: true })
    expect(parseRpcLine(line, 's1')).toEqual({ kind: 'none' })
  })

  it('maps text_delta message updates to assistant messages', () => {
    const line = JSON.stringify({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' }
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: { type: 'message', sessionId: 's1', role: 'assistant', content: 'Hello' }
    })
  })

  it('maps thinking_delta message updates to thinking events', () => {
    const line = JSON.stringify({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: { type: 'thinking', sessionId: 's1', delta: 'hmm' }
    })
  })

  it('ignores non-text message updates (thinking start/end, toolcall)', () => {
    for (const type of ['thinking_start', 'thinking_end', 'toolcall_delta']) {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type, contentIndex: 0 }
      })
      expect(parseRpcLine(line, 's1')).toEqual({ kind: 'none' })
    }
  })

  it('maps tool_execution_start to tool_call with its toolCallId', () => {
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'ls' }
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: { type: 'tool_call', sessionId: 's1', id: 't1', tool: 'bash', input: { command: 'ls' } }
    })
  })

  it('maps tool_execution_end to tool_result with toolCallId and error flag', () => {
    const line = JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'done\n' }] },
      isError: false
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: {
        type: 'tool_result',
        sessionId: 's1',
        id: 't1',
        tool: 'bash',
        output: 'done\n',
        isError: false
      }
    })
  })

  it('extracts text from structured tool results and never emits [object Object]', () => {
    const structured = JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 't2',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] },
      isError: false
    })
    const ev = parseRpcLine(structured, 's1')
    expect(ev.kind).toBe('event')
    if (ev.kind === 'event' && ev.event.type === 'tool_result') {
      expect(ev.event.output).toBe('line1\nline2')
    }
    // Unknown object shapes fall back to JSON text, not [object Object]
    const odd = JSON.stringify({
      type: 'tool_execution_end',
      toolName: 'custom',
      result: { weird: true },
      isError: false
    })
    const ev2 = parseRpcLine(odd, 's1')
    if (ev2.kind === 'event' && ev2.event.type === 'tool_result') {
      expect(String(ev2.event.output)).toContain('weird')
      expect(String(ev2.event.output)).not.toContain('[object Object]')
    }
  })

  it('omits the toolCallId when upstream does not send one', () => {
    const line = JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: {} })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: { type: 'tool_call', sessionId: 's1', tool: 'read', input: {} }
    })
  })

  it('ignores tool_execution_update partial results', () => {
    const line = JSON.stringify({
      type: 'tool_execution_update',
      toolCallId: 't1',
      toolName: 'bash',
      partialResult: { output: 'half' }
    })
    expect(parseRpcLine(line, 's1')).toEqual({ kind: 'none' })
  })

  it('maps extension notify requests to system messages', () => {
    const line = JSON.stringify({
      type: 'extension_ui_request',
      id: 'x1',
      method: 'notify',
      message: 'hello from extension'
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: { type: 'message', sessionId: 's1', role: 'system', content: 'hello from extension' }
    })
  })

  it('flags interactive extension requests with their full payload', () => {
    const line = JSON.stringify({
      type: 'extension_ui_request',
      id: 'x2',
      method: 'confirm',
      title: 'Proceed?',
      message: 'Run rm -rf build?'
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'extension_ui',
      id: 'x2',
      method: 'confirm',
      title: 'Proceed?',
      message: 'Run rm -rf build?'
    })
  })

  it('carries select options and input placeholders', () => {
    const select = JSON.stringify({
      type: 'extension_ui_request',
      id: 'x3',
      method: 'select',
      title: 'Pick one',
      options: ['a', 'b']
    })
    expect(parseRpcLine(select, 's1')).toEqual({
      kind: 'extension_ui',
      id: 'x3',
      method: 'select',
      title: 'Pick one',
      options: ['a', 'b']
    })

    const input = JSON.stringify({
      type: 'extension_ui_request',
      id: 'x4',
      method: 'input',
      title: 'Name?',
      placeholder: 'type here'
    })
    expect(parseRpcLine(input, 's1')).toEqual({
      kind: 'extension_ui',
      id: 'x4',
      method: 'input',
      title: 'Name?',
      placeholder: 'type here'
    })
  })

  it('surfaces unsupported fire-and-forget extension UI methods', () => {
    for (const method of ['setStatus', 'setWidget', 'setTitle', 'set_editor_text']) {
      const line = JSON.stringify({ type: 'extension_ui_request', id: 'x9', method })
      expect(parseRpcLine(line, 's1')).toEqual({ kind: 'extension_ui_unsupported', method })
    }
  })

  it('rejects malformed extension dialogs before they can block a session', () => {
    expect(
      parseRpcLine(
        JSON.stringify({ type: 'extension_ui_request', id: '', method: 'confirm', title: 'Proceed?' }),
        's1'
      )
    ).toEqual({ kind: 'extension_ui_invalid', reason: 'The extension sent a dialog without a valid id.' })
    expect(
      parseRpcLine(
        JSON.stringify({ type: 'extension_ui_request', id: 'x1', method: 'open_url', url: 'file:///etc/passwd' }),
        's1'
      )
    ).toEqual({ kind: 'extension_ui_invalid', reason: 'The extension requested an invalid external URL.' })
  })

  it('bounds extension dialog presentation data', () => {
    const line = JSON.stringify({
      type: 'extension_ui_request',
      id: 'x1',
      method: 'select',
      title: 'a'.repeat(3_000),
      message: 'b'.repeat(20_000),
      options: Array.from({ length: 120 }, (_, i) => `${i}:${'c'.repeat(2_100)}`),
      timeout: 25 * 60 * 60 * 1_000
    })
    const parsed = parseRpcLine(line, 's1')
    expect(parsed.kind).toBe('extension_ui')
    if (parsed.kind !== 'extension_ui') return
    expect(parsed.title).toHaveLength(2_000)
    expect(parsed.message).toHaveLength(16_000)
    expect(parsed.options).toHaveLength(100)
    expect(parsed.options?.[0]).toHaveLength(2_000)
    expect(parsed.timeout).toBeUndefined()
  })

  it('maps agent lifecycle events to working status', () => {
    expect(parseRpcLine(JSON.stringify({ type: 'agent_start' }), 's1')).toEqual({
      kind: 'event',
      event: { type: 'status', sessionId: 's1', status: 'working' }
    })
    // pi 0.80.3: agent_end is terminal and carries no isTerminal field.
    expect(parseRpcLine(JSON.stringify({ type: 'agent_end' }), 's1')).toEqual({
      kind: 'event',
      event: { type: 'status', sessionId: 's1', status: 'idle', isTerminal: true }
    })
  })

  it('passes an explicit agent_end isTerminal through (future upstream)', () => {
    expect(parseRpcLine(JSON.stringify({ type: 'agent_end', isTerminal: false }), 's1')).toEqual({
      kind: 'event',
      event: { type: 'status', sessionId: 's1', status: 'idle', isTerminal: false }
    })
    expect(parseRpcLine(JSON.stringify({ type: 'agent_end', isTerminal: true }), 's1')).toEqual({
      kind: 'event',
      event: { type: 'status', sessionId: 's1', status: 'idle', isTerminal: true }
    })
  })

  it('maps compaction lifecycle events to compaction phases', () => {
    expect(parseRpcLine(JSON.stringify({ type: 'compaction_start' }), 's1')).toEqual({
      kind: 'event',
      event: { type: 'compaction', sessionId: 's1', phase: 'start' }
    })
    expect(parseRpcLine(JSON.stringify({ type: 'compaction_end' }), 's1')).toEqual({
      kind: 'event',
      event: { type: 'compaction', sessionId: 's1', phase: 'end' }
    })
  })

  it('maps current-runtime auto_compaction events to the same phases', () => {
    const start = JSON.stringify({
      type: 'auto_compaction_start',
      reason: 'threshold',
      action: 'context-full'
    })
    expect(parseRpcLine(start, 's1')).toEqual({
      kind: 'event',
      event: { type: 'compaction', sessionId: 's1', phase: 'start' }
    })
    const end = JSON.stringify({
      type: 'auto_compaction_end',
      action: 'context-full',
      result: undefined,
      aborted: false,
      willRetry: false
    })
    expect(parseRpcLine(end, 's1')).toEqual({
      kind: 'event',
      event: { type: 'compaction', sessionId: 's1', phase: 'end' }
    })
  })

  it('maps command_output to a system message (local slash command results)', () => {
    const line = JSON.stringify({ type: 'command_output', text: 'Current model: deepseek/x' })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: {
        type: 'message',
        sessionId: 's1',
        role: 'system',
        content: 'Current model: deepseek/x'
      }
    })
  })

  it('maps prompt_result frames to their own kind', () => {
    expect(
      parseRpcLine(JSON.stringify({ type: 'prompt_result', id: 'p1', agentInvoked: false }), 's1')
    ).toEqual({ kind: 'prompt_result', id: 'p1', agentInvoked: false })
    expect(parseRpcLine(JSON.stringify({ type: 'prompt_result', agentInvoked: true }), 's1')).toEqual(
      { kind: 'prompt_result', id: undefined, agentInvoked: true }
    )
  })

  it('maps auto_retry_start to one informational system message', () => {
    const line = JSON.stringify({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: 'rate limited\n{"body":{}}'
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: {
        type: 'message',
        sessionId: 's1',
        role: 'system',
        content: 'Retrying (1/3)… rate limited'
      }
    })
  })

  it('ignores retry end/success frames (the stream itself shows recovery)', () => {
    for (const frame of [
      { type: 'auto_retry_end', success: true, attempt: 1 },
      { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'x' },
      { type: 'retry_fallback_succeeded', model: 'm', role: 'main' }
    ]) {
      expect(parseRpcLine(JSON.stringify(frame), 's1')).toEqual({ kind: 'none' })
    }
  })

  it('maps retry_fallback_applied to a system message', () => {
    const line = JSON.stringify({ type: 'retry_fallback_applied', from: 'a', to: 'b', role: 'main' })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: {
        type: 'message',
        sessionId: 's1',
        role: 'system',
        content: 'Model fallback: a → b'
      }
    })
  })

  it('maps warning/error notices to system messages, drops info chatter', () => {
    expect(
      parseRpcLine(JSON.stringify({ type: 'notice', level: 'warning', message: 'careful' }), 's1')
    ).toEqual({
      kind: 'event',
      event: { type: 'message', sessionId: 's1', role: 'system', content: 'careful' }
    })
    expect(
      parseRpcLine(JSON.stringify({ type: 'notice', level: 'info', message: 'mounted mcp' }), 's1')
    ).toEqual({ kind: 'none' })
  })

  it('maps extension_ui cancel to its own kind with the target id', () => {
    const line = JSON.stringify({ type: 'extension_ui_request', id: 'c1', method: 'cancel', targetId: 'x1' })
    expect(parseRpcLine(line, 's1')).toEqual({ kind: 'extension_ui_cancel', targetId: 'x1' })
  })

  it('maps open_url requests with the optional launchUrl', () => {
    const line = JSON.stringify({
      type: 'extension_ui_request',
      id: 'o1',
      method: 'open_url',
      url: 'https://example.com/auth',
      launchUrl: 'http://127.0.0.1:8080/launch'
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'open_url',
      url: 'https://example.com/auth',
      launchUrl: 'http://127.0.0.1:8080/launch',
      instructions: undefined
    })
  })

  it('ignores current-runtime frames the GUI does not surface', () => {
    for (const frame of [
      { type: 'available_commands_update', commands: [] },
      { type: 'session_info_update', title: 'x', sessionId: 'abc' },
      { type: 'config_update', model: {}, thinkingLevel: 'high' },
      { type: 'goal_updated', goal: null },
      { type: 'todo_reminder', todos: [], attempt: 1, maxAttempts: 3 },
      { type: 'todo_auto_clear' },
      { type: 'ttsr_triggered', rules: [] },
      { type: 'host_tool_call', id: 'h1', toolCallId: 't1', toolName: 'x', arguments: {} },
      { type: 'host_tool_cancel', id: 'h2', targetId: 'h1' },
      { type: 'host_uri_request', id: 'u1', operation: 'read', url: 'db://x' },
      { type: 'a_future_frame_nobody_knows', whatever: true }
    ]) {
      expect(parseRpcLine(JSON.stringify(frame), 's1')).toEqual({ kind: 'none' })
    }
  })

  it('maps thinking_level_changed with the runtime-resolved level', () => {
    expect(
      parseRpcLine(JSON.stringify({ type: 'thinking_level_changed', thinkingLevel: 'max' }), 's1')
    ).toEqual({
      kind: 'event',
      event: { type: 'thinking_level_changed', sessionId: 's1', level: 'max' }
    })
    // Absent level = runtime "auto"
    expect(parseRpcLine(JSON.stringify({ type: 'thinking_level_changed' }), 's1')).toEqual({
      kind: 'event',
      event: { type: 'thinking_level_changed', sessionId: 's1', level: undefined }
    })
  })

  it('maps model_changed to a refetch hint', () => {
    expect(parseRpcLine(JSON.stringify({ type: 'model_changed' }), 's1')).toEqual({
      kind: 'event',
      event: { type: 'model_changed', sessionId: 's1' }
    })
  })

  it('ignores turn and queue events', () => {
    for (const type of ['turn_start', 'turn_end', 'queue_update']) {
      expect(parseRpcLine(JSON.stringify({ type }), 's1')).toEqual({ kind: 'none' })
    }
  })

  it('falls back to a plain-text message for non-JSON lines', () => {
    expect(parseRpcLine('not json at all', 's1')).toEqual({
      kind: 'event',
      event: { type: 'message', sessionId: 's1', role: 'assistant', content: 'not json at all' }
    })
  })

  it('surfaces provider errors from the final assistant message', () => {
    const line = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'OpenAI API error (401): invalid_api_key'
      }
    })
    expect(parseRpcLine(line, 's1')).toEqual({
      kind: 'event',
      event: { type: 'error', sessionId: 's1', message: 'OpenAI API error (401): invalid_api_key' }
    })
  })

  it('ignores message_end for normal and aborted turns', () => {
    for (const stopReason of ['stop', 'length', 'aborted']) {
      const line = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason }
      })
      expect(parseRpcLine(line, 's1')).toEqual({ kind: 'none' })
    }
    // user message_end
    expect(
      parseRpcLine(
        JSON.stringify({ type: 'message_end', message: { role: 'user', content: [] } }),
        's1'
      )
    ).toEqual({ kind: 'none' })
  })
})

describe('extensionUiCancel', () => {
  it('builds a cancel response line', () => {
    expect(extensionUiCancel('abc')).toBe(
      '{"type":"extension_ui_response","id":"abc","cancelled":true}\n'
    )
  })
})

describe('extensionUiResponse', () => {
  it('builds value, confirmed and cancelled response lines', () => {
    expect(extensionUiResponse('a', { value: 'yes' })).toBe(
      '{"type":"extension_ui_response","id":"a","value":"yes"}\n'
    )
    expect(extensionUiResponse('b', { confirmed: false })).toBe(
      '{"type":"extension_ui_response","id":"b","confirmed":false}\n'
    )
    expect(extensionUiResponse('c', { cancelled: true })).toBe(
      '{"type":"extension_ui_response","id":"c","cancelled":true}\n'
    )
  })
})
