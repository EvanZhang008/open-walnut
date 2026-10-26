/**
 * The idle clock's line filter (src/providers/stream-activity.ts). The quiet
 * lines are the exact heads a real idle CLI wrote after a server start
 * (2026-10-25, Claude Code 2.1.284).
 */
import { describe, expect, it } from 'vitest'
import { cliStateOf, isConversationActivityLine } from '../../src/providers/stream-activity.js'

describe('isConversationActivityLine', () => {
  it('Walnut control exchanges and CLI status notices do not count', () => {
    for (const line of [
      '{"type":"control_response","response":{"subtype":"success","request_id":"sq-1"}}',
      '{"type":"system","subtype":"commands_changed","commands":[{"name":"add-dir"}]}',
      '{"type":"system","subtype":"control_request_progress","request_id":"sq-1"}',
      '{"type":"system","subtype":"hook_started","hook_id":"h"}',
      '{"type":"system","subtype":"hook_response","hook_id":"h"}',
      '{"type":"system","subtype":"session_state_changed","state":"idle","uuid":"u"}',
      '{"type":"command_lifecycle","command_uuid":"c"}',
      '{"type":"keep_alive"}',
    ]) expect(isConversationActivityLine(line), line).toBe(false)
  })

  it('the conversation counts, and so does anything unrecognised', () => {
    for (const line of [
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0}}',
      '{"type":"assistant","message":{"model":"m","id":"msg_1"}}',
      '{"type":"user","message":{"role":"user","content":"hi"}}',
      '{"type":"user","subtype":"walnut-injected","message":{"role":"user","content":"go"}}',
      '{"type":"result","subtype":"success","duration_ms":1}',
      '{"duration_api_ms":89248,"stop_reason":"end_turn","session_id":"s"}',
      '{"type":"system","subtype":"init","session_id":"s"}',
      '{"type":"system","subtype":"compact_boundary"}',
      '{"type":"tool_progress","tool_use_id":"t"}',
      'not json at all',
    ]) expect(isConversationActivityLine(line), line).toBe(true)
  })
})

describe('cliStateOf', () => {
  it('reads the state of a session_state_changed line and nothing else', () => {
    expect(cliStateOf('{"type":"system","subtype":"session_state_changed","state":"idle","uuid":"u"}')).toBe('idle')
    expect(cliStateOf('{"type":"system","subtype":"session_state_changed","state":"running","uuid":"u"}')).toBe('running')
    expect(cliStateOf('{"type":"system","subtype":"session_state_changed","state":"requires_action"}')).toBe('requires_action')
    expect(cliStateOf('{"type":"system","subtype":"session_state_changed","state":"paused"}')).toBeNull()
    expect(cliStateOf('{"type":"assistant","message":{"content":"state idle"}}')).toBeNull()
  })
})
