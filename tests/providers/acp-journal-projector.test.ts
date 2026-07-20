import { describe, expect, it } from 'vitest'
import {
  AcpJournalProjector,
  projectAcpJournalHistory,
} from '../../src/providers/acp-journal-projector.js'
import { AcpStreamNormalizer } from '../../src/providers/acp-stream-normalizer.js'
import { acpEventDestinations } from '../../src/providers/acp-session.js'
import type { JournalRecord } from '../../src/providers/acp-worker/protocol.js'

const meta = (ts: number, event: JournalRecord & never): JournalRecord =>
  ({ kind: 'meta', ts, event } as unknown as JournalRecord)

const frame = (
  ts: number,
  update: Record<string, unknown>,
  source: 'live' | 'provider-replay' | 'control' = 'live',
): JournalRecord => ({
  kind: 'acp',
  ts,
  source,
  frame: { method: 'session/update', params: { sessionId: 'provider-1', update } },
})

describe('ACP journal projector', () => {
  it('routes display and permissions only through main-ai, with terminal events also reaching session-runner', () => {
    for (const name of [
      'session:text-delta',
      'session:thinking-delta',
      'session:tool-use',
      'session:tool-result',
      'session:permission-request',
      'session:permission-resolved',
    ]) {
      expect(acpEventDestinations(name)).toEqual(['main-ai'])
    }
    expect(acpEventDestinations('session:result')).toEqual(['main-ai', 'session-runner'])
    expect(acpEventDestinations('session:error')).toEqual(['main-ai', 'session-runner'])
  })

  it('preserves text/tool/text order with deterministic turn-scoped identities', () => {
    const records: JournalRecord[] = [
      meta(1, {
        type: 'prompt-accepted',
        commandId: 'acp-prompt:qm-1',
        walnutMessageId: 'qm-1',
        text: 'do it exactly',
      } as never),
      meta(2, { type: 'turn-started', commandId: 'acp-prompt:qm-1' } as never),
      frame(3, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'provider-msg-1',
        content: { type: 'text', text: 'before' },
      }),
      frame(4, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Run',
        rawInput: { command: 'true' },
      }),
      frame(5, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: 'ok',
      }),
      frame(6, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'provider-msg-2',
        content: { type: 'text', text: 'after' },
      }),
      meta(7, {
        type: 'turn-ended',
        commandId: 'acp-prompt:qm-1',
        stopReason: 'end_turn',
      } as never),
    ]

    const first = projectAcpJournalHistory('runtime-1', records)
    const second = projectAcpJournalHistory('runtime-1', records)
    expect(second).toEqual(first)
    expect(first.map((m) => [m.role, m.text, m.tools?.[0]?.result])).toEqual([
      ['user', 'do it exactly', undefined],
      ['assistant', 'before', undefined],
      ['assistant', '', 'ok'],
      ['assistant', 'after', undefined],
    ])
    expect(first[0]).toMatchObject({ walnutMessageId: 'qm-1' })
    expect(first.slice(1).map((m) => m.msgId)).toEqual([
      'acp:runtime-1:acp-prompt:qm-1:segment:0',
      'acp:runtime-1:acp-prompt:qm-1:segment:1',
      'acp:runtime-1:acp-prompt:qm-1:segment:2',
    ])
    expect(first[2].tools?.[0].toolUseId).toBe(
      'acp:runtime-1:acp-prompt:qm-1:tool:1:tool-1',
    )
  })

  it('keeps recycled toolCallIds as distinct tool instances within one turn', () => {
    // Codex reuses short toolCallIds (call_2 here) for DIFFERENT tools in a turn.
    // Each call instance must get its own toolUseId (its own panel) and its result
    // must pair to the right instance — no collision, no dedup/drop.
    const records: JournalRecord[] = [
      meta(1, {
        type: 'prompt-accepted',
        commandId: 'acp-prompt:qm-recycle',
        walnutMessageId: 'qm-recycle',
        text: 'run both',
      } as never),
      meta(2, { type: 'turn-started', commandId: 'acp-prompt:qm-recycle' } as never),
      frame(3, { sessionUpdate: 'tool_call', toolCallId: 'call_2', title: 'Tool A', rawInput: { a: 1 } }),
      frame(4, { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'completed', rawOutput: 'result A' }),
      frame(5, { sessionUpdate: 'tool_call', toolCallId: 'call_2', title: 'Tool B', rawInput: { b: 2 } }),
      frame(6, { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'completed', rawOutput: 'result B' }),
      meta(7, { type: 'turn-ended', commandId: 'acp-prompt:qm-recycle', stopReason: 'end_turn' } as never),
    ]

    const first = projectAcpJournalHistory('runtime-recycle', records)
    const second = projectAcpJournalHistory('runtime-recycle', records)
    expect(second).toEqual(first)

    const tools = first.filter((m) => m.tools?.length).flatMap((m) => m.tools ?? [])
    expect(tools.map((t) => [t.name, t.result])).toEqual([
      ['Tool A', 'result A'],
      ['Tool B', 'result B'],
    ])
    const ids = tools.map((t) => t.toolUseId)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([
      'acp:runtime-recycle:acp-prompt:qm-recycle:tool:0:call_2',
      'acp:runtime-recycle:acp-prompt:qm-recycle:tool:1:call_2',
    ])
  })

  it('folds later chunks into the exact same assistant frame', () => {
    const records: JournalRecord[] = [
      meta(1, {
        type: 'prompt-accepted',
        commandId: 'acp-prompt:qm-slow',
        walnutMessageId: 'qm-slow',
        text: 'slow reply',
      } as never),
      frame(2, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'thinking...' },
      }),
      frame(3, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'still working...' },
      }),
      frame(4, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done: slow reply' },
      }),
      meta(5, {
        type: 'turn-ended',
        commandId: 'acp-prompt:qm-slow',
        stopReason: 'end_turn',
      } as never),
    ]

    expect(projectAcpJournalHistory('runtime-slow', records)).toEqual([
      expect.objectContaining({
        role: 'user',
        text: 'slow reply',
        msgId: 'acp:runtime-slow:acp-prompt:qm-slow:user',
      }),
      expect.objectContaining({
        role: 'assistant',
        text: 'thinking...still working...done: slow reply',
        msgId: 'acp:runtime-slow:acp-prompt:qm-slow:segment:0',
      }),
    ])
  })

  it('excludes provider-load replay from both live normalization and history', () => {
    const records: JournalRecord[] = [
      frame(1, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old provider replay' },
      }, 'provider-replay'),
      meta(2, {
        type: 'prompt-accepted',
        commandId: 'acp-prompt:qm-live',
        walnutMessageId: 'qm-live',
        text: 'new prompt',
      } as never),
      frame(3, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'new live reply' },
      }),
    ]
    const projector = new AcpJournalProjector('runtime-2')
    const normalizer = new AcpStreamNormalizer(projector)
    const live = records.flatMap((record) => normalizer.normalize(record))

    expect(live.filter((event) => event.name === 'session:text-delta')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ delta: 'new live reply' }) }),
    ])
    expect(projectAcpJournalHistory('runtime-2', records).map((m) => m.text)).toEqual([
      'new prompt',
      'new live reply',
    ])
  })

  it('excludes self-report control facts and frames from live normalization and history', () => {
    const records: JournalRecord[] = [
      meta(1, {
        type: 'control-prompt-accepted',
        commandId: 'acp-self-report:one',
        purpose: 'self-report',
      } as never),
      frame(2, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'private report' },
      }, 'control'),
      meta(3, {
        type: 'control-ended',
        commandId: 'acp-self-report:one',
        stopReason: 'end_turn',
      } as never),
    ]
    const normalizer = new AcpStreamNormalizer(new AcpJournalProjector('runtime-control'))
    expect(records.flatMap((record) => normalizer.normalize(record))).toEqual([])
    expect(projectAcpJournalHistory('runtime-control', records)).toEqual([])
  })

  it('keeps legacy assistant history without inventing user text', () => {
    const records: JournalRecord[] = [
      meta(1, { type: 'turn-started', commandId: 'legacy-command' } as never),
      frame(2, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'legacy reply' },
      }),
    ]
    expect(projectAcpJournalHistory('runtime-legacy', records)).toEqual([
      expect.objectContaining({ role: 'assistant', text: 'legacy reply' }),
    ])
  })

  it('recovers legacy user turns from the session/load replay burst', () => {
    // Legacy schema: per-turn fact is `command-accepted {op:'prompt'}` with NO
    // text; the prompt text survives only in the provider replay burst. Modeled
    // on real prod journal acp-31a287e01e3c3e4e (0 user msgs before this fix).
    const records: JournalRecord[] = [
      meta(1, { type: 'session-created', providerSessionId: 'p-1' } as never),
      meta(2, { type: 'command-accepted', op: 'prompt', commandId: 'qc-aaa' } as never),
      meta(3, { type: 'turn-started', commandId: 'qc-aaa' } as never),
      frame(4, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply one' } }),
      meta(5, { type: 'turn-ended', commandId: 'qc-aaa', stopReason: 'end_turn' } as never),
      meta(6, { type: 'command-accepted', op: 'prompt', commandId: 'qc-bbb' } as never),
      meta(7, { type: 'turn-started', commandId: 'qc-bbb' } as never),
      frame(8, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply two' } }),
      meta(9, { type: 'turn-ended', commandId: 'qc-bbb', stopReason: 'end_turn' } as never),
      // A later session/load replays the full conversation as one burst.
      meta(10, { type: 'session-loaded', providerSessionId: 'p-1' } as never),
      frame(11, { sessionUpdate: 'user_message_chunk', messageId: 'item-1', content: { type: 'text', text: 'first prompt' } }, 'provider-replay'),
      frame(12, { sessionUpdate: 'agent_message_chunk', messageId: 'item-2', content: { type: 'text', text: 'reply one' } }, 'provider-replay'),
      frame(13, { sessionUpdate: 'user_message_chunk', messageId: 'item-3', content: { type: 'text', text: 'second prompt' } }, 'provider-replay'),
      frame(14, { sessionUpdate: 'agent_message_chunk', messageId: 'item-4', content: { type: 'text', text: 'reply two' } }, 'provider-replay'),
    ]

    const history = projectAcpJournalHistory('runtime-legacy-load', records)
    expect(history.filter((m) => m.role === 'user').map((m) => [m.text, m.walnutMessageId])).toEqual([
      ['first prompt', 'qc-aaa'],
      ['second prompt', 'qc-bbb'],
    ])
    // Recovered user turns are positioned before their live assistant reply,
    // preserving conversation order; replay assistant frames stay excluded.
    expect(history.map((m) => [m.role, m.text])).toEqual([
      ['user', 'first prompt'],
      ['assistant', 'reply one'],
      ['user', 'second prompt'],
      ['assistant', 'reply two'],
    ])
  })

  it('excludes leaked self-report control prompts from legacy recovery', () => {
    // The provider sometimes retained the hidden turn-complete self-report as a
    // user turn in its history (seen in prod acp-31a287e01e3c3e4e). It must not
    // become a recovered user message nor shift the positional pairing.
    const records: JournalRecord[] = [
      meta(1, { type: 'session-created', providerSessionId: 'p-2' } as never),
      meta(2, { type: 'command-accepted', op: 'prompt', commandId: 'qc-one' } as never),
      meta(3, { type: 'turn-started', commandId: 'qc-one' } as never),
      frame(4, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ack' } }),
      meta(5, { type: 'turn-ended', commandId: 'qc-one', stopReason: 'end_turn' } as never),
      meta(6, { type: 'session-loaded', providerSessionId: 'p-2' } as never),
      frame(7, { sessionUpdate: 'user_message_chunk', messageId: 'item-1', content: { type: 'text', text: 'real question' } }, 'provider-replay'),
      frame(8, { sessionUpdate: 'agent_message_chunk', messageId: 'item-2', content: { type: 'text', text: 'ack' } }, 'provider-replay'),
      frame(9, {
        sessionUpdate: 'user_message_chunk',
        messageId: 'item-3',
        content: { type: 'text', text: "You just finished a turn. Update this task's NOTE — the single living document..." },
      }, 'provider-replay'),
    ]

    const users = projectAcpJournalHistory('runtime-selfreport', records).filter((m) => m.role === 'user')
    expect(users.map((m) => m.text)).toEqual(['real question'])
  })

  it('does not duplicate user turns when a modern journal carries both record kinds', () => {
    // Dedup guard: a command that already has a real prompt-accepted is skipped
    // even if a command-accepted {op:'prompt'} exists for it, so the single-turn
    // user message is emitted exactly once (never doubled).
    const records: JournalRecord[] = [
      meta(1, { type: 'command-accepted', op: 'prompt', commandId: 'acp-prompt:qm-dup' } as never),
      meta(2, {
        type: 'prompt-accepted',
        commandId: 'acp-prompt:qm-dup',
        walnutMessageId: 'qm-dup',
        text: 'only once',
      } as never),
      meta(3, { type: 'turn-started', commandId: 'acp-prompt:qm-dup' } as never),
      frame(4, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } }),
      meta(5, { type: 'turn-ended', commandId: 'acp-prompt:qm-dup', stopReason: 'end_turn' } as never),
      // Even a replay burst present alongside must not add a second user turn.
      meta(6, { type: 'session-loaded', providerSessionId: 'p-3' } as never),
      frame(7, { sessionUpdate: 'user_message_chunk', messageId: 'item-1', content: { type: 'text', text: 'only once' } }, 'provider-replay'),
      frame(8, { sessionUpdate: 'agent_message_chunk', messageId: 'item-2', content: { type: 'text', text: 'reply' } }, 'provider-replay'),
    ]

    const users = projectAcpJournalHistory('runtime-dup', records).filter((m) => m.role === 'user')
    expect(users.map((m) => [m.text, m.walnutMessageId])).toEqual([['only once', 'qm-dup']])
  })

  it('leaves a modern-only journal (prompt-accepted, no legacy command) untouched', () => {
    const records: JournalRecord[] = [
      meta(1, {
        type: 'prompt-accepted',
        commandId: 'acp-prompt:qm-modern',
        walnutMessageId: 'qm-modern',
        text: 'modern prompt',
      } as never),
      meta(2, { type: 'turn-started', commandId: 'acp-prompt:qm-modern' } as never),
      frame(3, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'modern reply' } }),
      meta(4, { type: 'turn-ended', commandId: 'acp-prompt:qm-modern', stopReason: 'end_turn' } as never),
    ]
    expect(projectAcpJournalHistory('runtime-modern', records).map((m) => [m.role, m.text])).toEqual([
      ['user', 'modern prompt'],
      ['assistant', 'modern reply'],
    ])
  })

  it('emits one system boundary when a protocol error is followed by interruption', () => {
    const records: JournalRecord[] = [
      meta(1, { type: 'turn-started', commandId: 'broken' } as never),
      meta(2, { type: 'error', errorKind: 'protocol', message: 'provider failed' } as never),
      meta(3, { type: 'turn-interrupted', reason: 'worker-crash', commandId: 'broken' } as never),
    ]
    const history = projectAcpJournalHistory('runtime-error', records)
    expect(history.filter((m) => m.role === 'system')).toEqual([
      expect.objectContaining({ text: 'protocol: provider failed', systemVariant: 'error' }),
    ])
  })

  it('surfaces indeterminate prompt delivery as an explicit retry warning', () => {
    const projector = new AcpJournalProjector('runtime-uncertain')
    const events = [
      ...projector.project(meta(1, {
        type: 'prompt-accepted',
        commandId: 'cmd-uncertain',
        walnutMessageId: 'qm-uncertain',
        text: 'possibly delivered',
      })),
      ...projector.project(meta(2, {
        type: 'turn-interrupted',
        commandId: 'cmd-uncertain',
        reason: 'dispatch-indeterminate',
      })),
    ]

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'system',
        commandId: 'cmd-uncertain',
        message: expect.stringMatching(/delivery is uncertain.*before retrying/i),
      }),
      expect.objectContaining({
        type: 'result',
        commandId: 'cmd-uncertain',
        stopReason: 'interrupted',
      }),
    ]))
  })
})
