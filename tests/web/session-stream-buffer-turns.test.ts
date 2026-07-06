/**
 * REGRESSION: turn-boundary semantics of the server-side stream buffer.
 *
 * Three sibling bugs from the 2026-07-06 pipeline audit (all bug-class (a):
 * wrong-boundary / missing state reset):
 *
 * 1. Deferred clear killed a live turn — `session:result` scheduled
 *    `setTimeout(clear, 2000)`; a message sent within 2s started a new turn
 *    (markStreaming + deltas already buffered), then the timer wiped the
 *    buffer AND the streaming flag → any reload during that turn rendered a
 *    blank snapshot with a dead badge. Fix: clearSoon() is cancelled by
 *    markStreaming.
 *
 * 2. Finished-turn blocks served as "live" — after markDone (idle between
 *    turns) blocks are retained for cross-turn viewing. When the NEXT turn's
 *    markStreaming fired before its first delta, getSnapshot returned the OLD
 *    blocks with isStreaming=true; the client stamped completedLen=0 ("live
 *    turn"), so evidence-promotion never removed them → permanent duplicates
 *    next to persisted history. Fix: snapshot carries a server-authoritative
 *    completedLen; turnEnded entries report blocks.length.
 *
 * 3. Old-turn blocks bled into the new turn — the first data append of a new
 *    turn must drop the finished turn's blocks (they live in history now).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js'

const SID = 'turn-test-session'

describe('sessionStreamBuffer turn boundaries', () => {
  beforeEach(() => {
    sessionStreamBuffer.clear(SID)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clearSoon is cancelled when a new turn starts inside the window', () => {
    vi.useFakeTimers()
    // Turn 1 streams and ends.
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'turn one')
    sessionStreamBuffer.markDone(SID)
    sessionStreamBuffer.clearSoon(SID, 2000)

    // 500ms later the user sends again — turn 2 starts and streams.
    vi.advanceTimersByTime(500)
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'turn two live')

    // The old timer window elapses — the buffer must survive.
    vi.advanceTimersByTime(3000)
    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.isStreaming).toBe(true)
    expect(snap.blocks.length).toBeGreaterThan(0)
    expect(snap.blocks.some(b => b.type === 'text' && b.content.includes('turn two'))).toBe(true)
  })

  it('clearSoon still clears when NO new turn starts', () => {
    vi.useFakeTimers()
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'only turn')
    sessionStreamBuffer.markDone(SID)
    sessionStreamBuffer.clearSoon(SID, 2000)
    vi.advanceTimersByTime(2500)
    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(0)
    expect(snap.isStreaming).toBe(false)
  })

  it('snapshot after markDone reports all blocks as completed', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'finished content')
    sessionStreamBuffer.markDone(SID)

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(1)
    expect(snap.completedLen).toBe(1)
  })

  it('snapshot between next-turn markStreaming and first delta still reports old blocks as completed', () => {
    // Turn 1 ends; blocks retained.
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'old turn')
    sessionStreamBuffer.markDone(SID)
    // Turn 2 begins — no delta yet. THE bug window.
    sessionStreamBuffer.markStreaming(SID)

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.isStreaming).toBe(true)
    // Old blocks must NOT be labelled live (completedLen=0 was the bug).
    expect(snap.completedLen).toBe(snap.blocks.length)
    expect(snap.completedLen).toBe(1)
  })

  it('first data append of the new turn drops the finished turn blocks', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'old turn')
    sessionStreamBuffer.markDone(SID)
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'new turn')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(1)
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'new turn' })
    expect(snap.completedLen).toBe(0) // genuinely live now
  })

  it('appendToolResult / resolvePermission do NOT reset a finished turn (they mutate it)', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendToolUse(SID, 'toolu_x', 'Bash')
    sessionStreamBuffer.markDone(SID)
    // Late tool_result for the finished turn's tool call.
    sessionStreamBuffer.appendToolResult(SID, 'toolu_x', 'late result')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(1)
    expect(snap.blocks[0]).toMatchObject({ type: 'tool_call', status: 'done', result: 'late result' })
    expect(snap.completedLen).toBe(1) // still a finished turn
  })
})
