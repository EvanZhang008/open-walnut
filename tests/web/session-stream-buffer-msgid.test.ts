/**
 * Phase 0 of the ACP-dialect alignment: message identity threading.
 *
 * The CLI stamps every assistant message with an API message id (`msg_…`) that
 * appears BOTH in the live SSE stream (message_start) and on the persisted
 * JSONL line — the same natural key on both sides of the streaming/history
 * seam. These tests pin the buffer's ACP message-boundary rule:
 *
 *   a CHANGE in msgId = a new message = a NEW block
 *
 * Without the rule, two consecutive assistant messages' text glued into one
 * block ("last block is text" accumulation), which is one reason promotion had
 * to fall back to fuzzy join-run content matching (see promote-blocks.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js'

const SID = 'msgid-test-session'

describe('sessionStreamBuffer msgId boundaries', () => {
  beforeEach(() => {
    sessionStreamBuffer.clear(SID)
  })

  it('accumulates same-msgId text deltas into one block and stamps the id', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'Hello ', 'msg_A')
    sessionStreamBuffer.appendTextDelta(SID, 'world', 'msg_A')
    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(1)
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'Hello world', msgId: 'msg_A' })
  })

  it('starts a NEW text block when msgId changes (two assistant messages in one turn)', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'first message', 'msg_A')
    sessionStreamBuffer.appendTextDelta(SID, 'second message', 'msg_B')
    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(2)
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'first message', msgId: 'msg_A' })
    expect(snap.blocks[1]).toMatchObject({ type: 'text', content: 'second message', msgId: 'msg_B' })
  })

  it('legacy events without msgId keep the historical last-block accumulation', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'a')
    sessionStreamBuffer.appendTextDelta(SID, 'b')
    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(1)
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'ab' })
  })

  it('id-less delta merges into an id-stamped block (mixed rollout) and vice versa', () => {
    // id → no-id: continuation deltas that lost the id must not fork a block
    sessionStreamBuffer.appendTextDelta(SID, 'x', 'msg_A')
    sessionStreamBuffer.appendTextDelta(SID, 'y')
    let snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(1)
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'xy', msgId: 'msg_A' })

    // no-id → id: block created before the id arrived adopts it on merge
    sessionStreamBuffer.clear(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'x')
    sessionStreamBuffer.appendTextDelta(SID, 'y', 'msg_B')
    snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(1)
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'xy', msgId: 'msg_B' })
  })

  it('thinking deltas follow the same boundary rule', () => {
    sessionStreamBuffer.appendThinkingDelta(SID, 'pondering…', 'msg_A')
    sessionStreamBuffer.appendThinkingDelta(SID, ' more', 'msg_A')
    sessionStreamBuffer.appendThinkingDelta(SID, 'new thought', 'msg_B')
    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(2)
    expect(snap.blocks[0]).toMatchObject({ type: 'thinking', content: 'pondering… more', msgId: 'msg_A' })
    expect(snap.blocks[1]).toMatchObject({ type: 'thinking', content: 'new thought', msgId: 'msg_B' })
  })

  it('text resumes accumulation after a tool call within the same message', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'before tool', 'msg_A')
    sessionStreamBuffer.appendToolUse(SID, 'toolu_1', 'Bash', { command: 'ls' })
    sessionStreamBuffer.appendTextDelta(SID, 'after tool', 'msg_A')
    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks.map((b) => b.type)).toEqual(['text', 'tool_call', 'text'])
    expect(snap.blocks[2]).toMatchObject({ type: 'text', content: 'after tool', msgId: 'msg_A' })
  })

  it('snapshot seq is monotonic across mutations and 0 with no buffer', () => {
    expect(sessionStreamBuffer.getSnapshot(SID).seq).toBe(0)
    sessionStreamBuffer.appendTextDelta(SID, 'a', 'msg_A')
    const s1 = sessionStreamBuffer.getSnapshot(SID).seq
    expect(s1).toBeGreaterThan(0)
    sessionStreamBuffer.appendTextDelta(SID, 'b', 'msg_A')
    const s2 = sessionStreamBuffer.getSnapshot(SID).seq
    expect(s2).toBeGreaterThan(s1)
    sessionStreamBuffer.markDone(SID)
    expect(sessionStreamBuffer.getSnapshot(SID).seq).toBeGreaterThan(s2)
  })
})
