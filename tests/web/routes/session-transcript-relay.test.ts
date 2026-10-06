/**
 * The pure halves of the replica's transcript relay (src/web/routes/session-transcript-relay.ts):
 * the cursor check both boxes apply, and the byte cap a relayed page is cut to
 * before it rides the bridge.
 *
 * Why the cap is pinned this closely: a page cut in the middle of rows that share
 * a timestamp loses the cut half for good (the client's next `before` is that
 * timestamp, which excludes the whole run), and an uncut page of long tool inputs
 * is the kind of bulk that ended the bridge in the field.
 */
import { describe, it, expect } from 'vitest'
import { capRelayedPage, isTranscriptCursor, TRANSCRIPT_RELAY_MAX_BYTES } from '../../../src/web/routes/session-transcript-relay.js'

interface Row { role: string; text: string; timestamp: string; kind?: string; inputPreview?: string }

const ts = (s: number): string => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString()
const page = (messages: Row[], truncated = false) => ({ version: 1 as const, sessionId: 's', exportedAt: 'x', truncated, messages })
const bytes = (p: object): number => Buffer.byteLength(JSON.stringify(p))

/** One tool row per second, each carrying `pad` bytes of input preview. */
function toolRows(n: number, pad: number, from = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    role: 'assistant', text: 'Edit', timestamp: ts(from + i), kind: 'tool', inputPreview: 'x'.repeat(pad),
  }))
}

describe('capRelayedPage', () => {
  it('leaves a page under the budget untouched', () => {
    const p = page(toolRows(50, 1_000))
    expect(capRelayedPage(p)).toBe(p)
  })

  it('cuts the oldest rows of a page over the budget and says there is more', () => {
    const rows = toolRows(600, 2_000)
    const p = page(rows)
    expect(bytes(p)).toBeGreaterThan(TRANSCRIPT_RELAY_MAX_BYTES)
    const cut = capRelayedPage(p)
    expect(bytes(cut)).toBeLessThanOrEqual(TRANSCRIPT_RELAY_MAX_BYTES)
    expect(cut.truncated).toBe(true)
    expect(cut.messages.at(-1)).toBe(rows.at(-1))
    // The newest rows that fit, contiguous: what is left is exactly the older part.
    expect(cut.messages).toEqual(rows.slice(rows.length - cut.messages.length))
    expect(cut.messages.length).toBeGreaterThan(200)
  })

  it('never splits rows that share a timestamp', () => {
    // Groups of three rows per history message (thinking, prose, tool call).
    const rows: Row[] = []
    for (let m = 0; m < 300; m++) {
      for (const kind of ['thinking', undefined, 'tool']) {
        rows.push({ role: 'assistant', text: kind ?? 'prose', timestamp: ts(m), ...(kind ? { kind } : {}), inputPreview: 'y'.repeat(900) })
      }
    }
    for (const budget of [100_000, 100_500, 101_000, 333_333]) {
      const cut = capRelayedPage(page(rows), budget)
      const first = cut.messages[0].timestamp
      const kept = cut.messages.filter((r) => r.timestamp === first).length
      expect(kept, `budget ${budget}`).toBe(3)
      expect(bytes(cut)).toBeLessThanOrEqual(budget)
      // The next page (`before` = first kept) holds every row that was cut.
      const rest = rows.filter((r) => r.timestamp < first)
      expect(rest.length + cut.messages.length).toBe(rows.length)
    }
  })

  it('keeps the newest run whole when even it is over the budget', () => {
    const rows = [...toolRows(3, 10), ...Array.from({ length: 4 }, () => ({ role: 'assistant', text: 'big', timestamp: ts(99), inputPreview: 'z'.repeat(5_000) }))]
    const cut = capRelayedPage(page(rows), 2_000)
    expect(cut.messages).toEqual(rows.slice(3))
    expect(cut.truncated).toBe(true)
  })

  it('a cut page of the start of a conversation is still truncated', () => {
    const cut = capRelayedPage(page(toolRows(600, 2_000), false))
    expect(cut.truncated).toBe(true)
  })
})

describe('isTranscriptCursor', () => {
  it('takes ISO timestamps and nothing that merely parses', () => {
    for (const ok of ['2026-01-01T00:00:00.000Z', '2026-10-04T10:00:00.000+02:00', '2026-10-04T10:00']) {
      expect(isTranscriptCursor(ok), ok).toBe(true)
    }
    for (const bad of ['yesterday', 'Jan 1 2026', '2026-13-45T99:99:99Z', 'x'.repeat(60), '', '2026-01-01']) {
      expect(isTranscriptCursor(bad), bad).toBe(false)
    }
  })
})
