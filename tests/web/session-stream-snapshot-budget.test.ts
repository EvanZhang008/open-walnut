/**
 * REGRESSION: the phone attach snapshot must be byte-budgeted.
 *
 * iOS main-thread audit IO-3 (2026-08-07): the /api/v1 session stream sends
 * the attach snapshot as ONE SSE `data:` line with NO size bound, while the
 * iOS client hard-caps a single SSE line at 4MB. A whale in-flight turn
 * (field incident: 206MB live region) produced a snapshot the client could
 * never accept: kill connection → reconnect → server re-sends the SAME
 * snapshot → forever. Silent livelock — no events delivered, ~4MB burned per
 * cycle, no user-visible error.
 *
 * Fix: budgetSnapshotBlocks() trims oldest blocks first and clips a single
 * oversized text/thinking block's head, keeping the newest content (the
 * phone's LiveMarkdownWindow renders only the newest ~96K chars anyway).
 * Applied on the v1 phone route only; the desktop web snapshot keeps full
 * fidelity.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  sessionStreamBuffer,
  budgetSnapshotBlocks,
  SNAPSHOT_BYTE_BUDGET,
  type StreamSnapshot,
} from '../../src/web/session-stream-buffer.js'

const SID = 'snapshot-budget-test'

function snapshotBytes(snap: StreamSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snap.blocks))
}

describe('budgetSnapshotBlocks', () => {
  beforeEach(() => {
    sessionStreamBuffer.clear(SID)
  })

  it('passes a normal snapshot through untouched', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'hello world '.repeat(100))
    sessionStreamBuffer.appendToolUse(SID, 'tu-1', 'Bash', { command: 'ls' })
    const raw = sessionStreamBuffer.getSnapshot(SID)
    const budgeted = budgetSnapshotBlocks(raw)
    expect(budgeted.blocks).toEqual(raw.blocks)
    expect(budgeted.completedLen).toBe(raw.completedLen)
    expect(budgeted.isStreaming).toBe(raw.isStreaming)
  })

  it('a whale live region serializes under the phone frame cap', () => {
    sessionStreamBuffer.markStreaming(SID)
    // Simulate a giant in-flight turn: many text runs split by tool calls so
    // the buffer holds many multi-MB blocks (~20MB content total).
    for (let i = 0; i < 20; i++) {
      sessionStreamBuffer.appendTextDelta(SID, `chunk-${i} `.repeat(1000) + 'x'.repeat(1_000_000), `msg_${i}`)
      sessionStreamBuffer.appendToolUse(SID, `tu-${i}`, 'Bash', { command: `step ${i}` })
    }
    const raw = sessionStreamBuffer.getSnapshot(SID)
    expect(snapshotBytes(raw)).toBeGreaterThan(4_194_304) // red precondition

    const budgeted = budgetSnapshotBlocks(raw)
    // The whole SSE frame (blocks JSON + envelope) must be far below the
    // client's 4MB single-line cap.
    expect(snapshotBytes(budgeted)).toBeLessThan(2_000_000)
    // Newest-first retention: the LAST raw block must survive.
    expect(budgeted.blocks[budgeted.blocks.length - 1]).toEqual(raw.blocks[raw.blocks.length - 1])
  })

  it('a SINGLE giant text block is head-clipped, keeping the newest tail', () => {
    const tail = 'THE-NEWEST-TAIL-CONTENT'
    const giant: StreamSnapshot = {
      blocks: [{ type: 'text', content: 'a'.repeat(8_000_000) + tail }],
      isStreaming: true,
      completedLen: 0,
      seq: 1,
    }
    const budgeted = budgetSnapshotBlocks(giant)
    expect(snapshotBytes(budgeted)).toBeLessThan(2_000_000)
    const content = (budgeted.blocks[0] as { content: string }).content
    expect(content.endsWith(tail)).toBe(true)
  })

  it('re-bases completedLen when finished-turn blocks are dropped', () => {
    const mb = 'x'.repeat(SNAPSHOT_BYTE_BUDGET) // each block alone busts the budget
    const snap: StreamSnapshot = {
      blocks: [
        { type: 'text', content: mb },          // finished turn (dropped)
        { type: 'text', content: mb },          // finished turn (dropped)
        { type: 'text', content: 'live tail' }, // live turn (kept)
      ],
      isStreaming: true,
      completedLen: 2,
      seq: 3,
    }
    const budgeted = budgetSnapshotBlocks(snap)
    expect(budgeted.blocks.length).toBeLessThan(3)
    const dropped = 3 - budgeted.blocks.length
    expect(budgeted.completedLen).toBe(Math.max(0, 2 - dropped))
    const last = budgeted.blocks[budgeted.blocks.length - 1] as { content: string }
    expect(last.content).toBe('live tail')
  })

  it('empty snapshot is a no-op', () => {
    const empty: StreamSnapshot = { blocks: [], isStreaming: false, completedLen: 0, seq: 0 }
    expect(budgetSnapshotBlocks(empty)).toEqual(empty)
  })
})
