/**
 * An ACP turn's `session:result` carries its final answer (the text after the
 * last tool call), the way Claude Code's result does. 2026-10-30: Ask Walnut on
 * OpenCode stored an empty reply every time, because the normalizer sent
 * `result: ''` and lane-turn.ts reads the answer from that field.
 */
import { describe, expect, it } from 'vitest'
import { AcpJournalProjector } from '../../src/providers/acp-journal-projector.js'
import { AcpStreamNormalizer } from '../../src/providers/acp-stream-normalizer.js'
import type { JournalRecord } from '../../src/providers/acp-worker/protocol.js'

const meta = (ts: number, event: Record<string, unknown>): JournalRecord =>
  ({ kind: 'meta', ts, event } as unknown as JournalRecord)
const update = (ts: number, u: Record<string, unknown>): JournalRecord => ({
  kind: 'acp', ts, source: 'live',
  frame: { method: 'session/update', params: { sessionId: 'p-1', update: u } },
} as unknown as JournalRecord)
const chunk = (ts: number, text: string, messageId = 'm') =>
  update(ts, { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })

function results(records: JournalRecord[]): string[] {
  const n = new AcpStreamNormalizer(new AcpJournalProjector('rt'))
  return records.flatMap((r) => n.normalize(r)).filter((e) => e.name === 'session:result').map((e) => e.payload.result as string)
}

const turn = (id: string, ts: number, body: JournalRecord[]): JournalRecord[] => [
  meta(ts, { type: 'prompt-accepted', commandId: id, walnutMessageId: `w-${id}`, text: 'hi' }),
  meta(ts + 1, { type: 'turn-started', commandId: id }),
  ...body,
  meta(ts + 50, { type: 'turn-ended', commandId: id, stopReason: 'end_turn' }),
]

describe('ACP session:result text', () => {
  it('a plain answer, streamed in chunks', () => {
    expect(results(turn('t1', 1, [chunk(2, 'Hello'), chunk(3, ', world.')]))).toEqual(['Hello, world.'])
  })

  it('only the text after the last tool call, never thinking', () => {
    expect(results(turn('t1', 1, [
      chunk(2, 'Let me look.', 'a'),
      update(3, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } }),
      update(4, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' }),
      update(5, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' }),
      chunk(6, 'The file says 42.', 'b'),
    ]))).toEqual(['The file says 42.'])
  })

  it('a turn that ends on a tool call answers empty, and nothing leaks into the next turn', () => {
    expect(results([
      ...turn('t1', 1, [chunk(2, 'first'), update(3, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash' })]),
      ...turn('t2', 100, [chunk(102, 'second')]),
    ])).toEqual(['', 'second'])
  })

  it('a resume\'s replay of the past conversation is not part of the answer', () => {
    const replayed = { ...chunk(2, 'banana', 'old'), source: 'provider-replay' } as JournalRecord
    expect(results([
      replayed,
      ...turn('t2', 10, [chunk(12, 'cherry')]),
    ])).toEqual(['cherry'])
    // Even when the replay lands inside the turn, before the answer.
    expect(results(turn('t3', 20, [{ ...chunk(22, 'banana', 'old'), source: 'provider-replay' } as JournalRecord, chunk(23, 'plum')]))).toEqual(['plum'])
  })

  it('a provider retry that streams the answer again is counted once', () => {
    const disconnected = update(4, {
      sessionUpdate: 'session_info_update',
      _meta: { codex: { error: { willRetry: true, codexErrorInfo: { responseStreamDisconnected: {} } } } },
    })
    expect(results(turn('t1', 1, [chunk(2, 'The answer'), disconnected, chunk(5, 'The answer is 42.', 'm2')]))).toEqual(['The answer is 42.'])
  })

  it('an interrupted turn carries what it had written', () => {
    expect(results([
      meta(1, { type: 'prompt-accepted', commandId: 't1', walnutMessageId: 'w', text: 'hi' }),
      meta(2, { type: 'turn-started', commandId: 't1' }),
      chunk(3, 'partial'),
      meta(4, { type: 'turn-interrupted', commandId: 't1', reason: 'user' }),
    ])).toEqual(['partial'])
  })
})
