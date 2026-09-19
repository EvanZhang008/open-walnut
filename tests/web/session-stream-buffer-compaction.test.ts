/**
 * The server-side twin of "ONE compaction is ONE row".
 *
 * The buffer is what a RELOAD (and every reconnecting client's snapshot) renders
 * from, so a rule only the browser reducer applied would look fixed until the
 * page was refreshed mid-compaction — and then the pile of five identical
 * "Compacting context..." rows from the 2026-09-18 report would be back, this
 * time served by the server.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js'
import { COMPACTED_MESSAGE, COMPACTING_MESSAGE } from '../../src/core/stream/compaction-notice.js'

const SID = 'compaction-buffer-test-session'
const DETAIL = '444K → 45K tokens · auto'

function systemRows() {
  return sessionStreamBuffer.getSnapshot(SID).blocks
    .filter((b) => b.type === 'system')
    .map((b) => b as { message: string; detail?: string; progress?: boolean })
}

function compacting() {
  sessionStreamBuffer.appendSystem(SID, 'compact', COMPACTING_MESSAGE, undefined, true)
}
function compacted(detail = DETAIL) {
  sessionStreamBuffer.appendSystem(SID, 'compact', COMPACTED_MESSAGE, detail)
}

describe('sessionStreamBuffer: one compaction, one snapshot row', () => {
  beforeEach(() => {
    sessionStreamBuffer.clear(SID)
  })

  it('the 30s keep-alive repeats collapse into the one placeholder', () => {
    sessionStreamBuffer.markStreaming(SID)
    for (let i = 0; i < 6; i++) compacting()
    expect(systemRows()).toEqual([
      { type: 'system', variant: 'compact', message: COMPACTING_MESSAGE, progress: true },
    ])
  })

  it('the boundary replaces the placeholder in place, keeping the text around it', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'thinking about it', 'msg_A')
    compacting()
    compacting()
    compacted()
    sessionStreamBuffer.appendTextDelta(SID, 'and continuing', 'msg_B')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks.map((b) => b.type)).toEqual(['text', 'system', 'text'])
    expect(systemRows()).toEqual([
      { type: 'system', variant: 'compact', message: COMPACTED_MESSAGE, detail: DETAIL },
    ])
  })

  it('a replayed [status, boundary] pair adds nothing (daemon reattach)', () => {
    sessionStreamBuffer.markStreaming(SID)
    compacting()
    compacted()
    compacting()
    compacted()
    expect(systemRows()).toHaveLength(1)
  })

  it('a second real compaction in the same turn gets its own row', () => {
    sessionStreamBuffer.markStreaming(SID)
    compacting()
    compacted()
    sessionStreamBuffer.appendTextDelta(SID, 'post-compact work', 'msg_B')
    compacting()
    compacted('612K → 47K tokens · auto')
    expect(systemRows().map((r) => r.detail)).toEqual([DETAIL, '612K → 47K tokens · auto'])
  })

  it('two identical API errors both survive — only compaction collapses', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendSystem(SID, 'error', 'API error: ECONNRESET')
    sessionStreamBuffer.appendSystem(SID, 'error', 'API error: ECONNRESET')
    expect(systemRows()).toHaveLength(2)
  })

  it('a collapsed repeat does not disturb the pending-markup carry', () => {
    // The placeholder is a card: it cuts the model's text. A DROPPED repeat must
    // not run that cut again (it would split the resumed text a second time).
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'before <div style="padding:8', 'msg_A')
    compacting()
    compacting()
    compacting()
    sessionStreamBuffer.appendTextDelta(SID, 'px">after</div>', 'msg_A')
    const texts = sessionStreamBuffer.getSnapshot(SID).blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { content: string }).content)
    expect(texts).toEqual(['before ', '<div style="padding:8px">after</div>'])
  })
})
