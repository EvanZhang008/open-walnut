/**
 * The activity-row ref codec (src/core/activity-detail.ts) — the identity a drawer
 * fetches a row's full text by.
 *
 * Why it is a codec at all: a row's POSITION cannot be the identity. The session
 * transcript serves a sliding ~100-message tail, so "row 12" means a different row
 * after the next turn, and the chat read's positional ids belong to its paging
 * cursor space. What survives a re-read of the same JSONL is the message's own id
 * plus the slot inside that message, and this file is that pair on the wire.
 *
 * Every case here is about failing CLOSED. A ref that round-trips to a DIFFERENT row
 * is the one outcome worse than no ref at all: the user would read another tool's
 * output believing it belonged to the row they tapped.
 */
import { describe, it, expect } from 'vitest'
import { activityRef, parseActivityRef } from '../../src/core/activity-detail.js'
import { HISTORY_TOOL_RESULT_MAX } from '../../src/core/session-history.js'
import { sectionHasMore, toolResultFullText } from '../../src/core/tool-summary.js'

describe('activity ref: round trip', () => {
  it('carries the session, the message id and the slot, and reads them back', () => {
    const thinking = activityRef('sess-abc_123', 'msg_01ABCdefGHijkl', { kind: 'thinking' })!
    expect(parseActivityRef(thinking)).toEqual({
      sessionId: 'sess-abc_123', msgId: 'msg_01ABCdefGHijkl', slot: { kind: 'thinking' },
    })

    const tool = activityRef('sess-abc_123', 'msg_01ABCdefGHijkl', { kind: 'tool', index: 3 })!
    expect(parseActivityRef(tool)).toEqual({
      sessionId: 'sess-abc_123', msgId: 'msg_01ABCdefGHijkl', slot: { kind: 'tool', index: 3 },
    })
    // The two slots of one message are distinct refs (a message can carry both).
    expect(tool).not.toBe(thinking)
  })

  it('round-trips the id shapes the CLI actually mints', () => {
    // An API message id, a JSONL line uuid, and the parser's synthetic fallback
    // (`<iso timestamp>-<index>`) — which contains colons and dots, so it is the one
    // that would break a naive delimiter or an unescaped URL.
    for (const msgId of [
      'msg_01XyZ', '9f6b2c14-8f2a-4c33-9a1e-77bc0d0e5f21', '2026-09-11T04:05:06.789Z-3',
    ]) {
      const ref = activityRef('sid', msgId, { kind: 'tool', index: 0 })!
      expect(ref, `no ref minted for ${msgId}`).toBeDefined()
      expect(parseActivityRef(ref)!.msgId, msgId).toBe(msgId)
      // Safe in a URL query without escaping (clients still encode; this is belt
      // and braces for a ref that shows up in a log line).
      expect(encodeURIComponent(ref)).toContain(encodeURIComponent(msgId))
    }
  })

  it('is stable: the same row mints the same ref twice', () => {
    expect(activityRef('sid', 'msg_1', { kind: 'tool', index: 2 }))
      .toBe(activityRef('sid', 'msg_1', { kind: 'tool', index: 2 }))
  })
})

describe('activity ref: refuses to mint what it cannot resolve', () => {
  it('mints nothing without a message id', () => {
    // A row with no id (an ACP journal entry, a hand-written line) simply carries no
    // ref, and the client keeps its excerpt. It must not fall back to a position.
    expect(activityRef('sid', undefined, { kind: 'thinking' })).toBeUndefined()
    expect(activityRef('sid', '', { kind: 'thinking' })).toBeUndefined()
  })

  it('mints nothing for ids that would not survive the round trip', () => {
    for (const msgId of ['has~tilde', 'has space', 'has/slash', 'has?query', 'has&amp', 'has#hash']) {
      expect(activityRef('sid', msgId, { kind: 'thinking' }), msgId).toBeUndefined()
    }
  })

  it('mints nothing for a session id outside the safe alphabet', () => {
    // Session ids reach filenames and RPC params; this is the same alphabet the
    // routes enforce, checked at MINT time so a bad id never reaches a client.
    for (const sid of ['../etc/passwd', 'has space', 'a/b', '']) {
      expect(activityRef(sid, 'msg_1', { kind: 'thinking' }), sid).toBeUndefined()
    }
  })
})

describe('activity ref: rejects anything it did not mint', () => {
  it('rejects malformed, wrong-version and out-of-alphabet refs', () => {
    for (const bad of [
      '', 'nonsense', '1~sid', '1~sid~msg', '1~sid~msg~k~extra',
      '2~sid~msg~k', '0~sid~msg~k', // an unknown version is never guessed at
      '1~../etc~msg~k', '1~sid~~k', // no session traversal, no empty message id
      '1~sid~msg~x', '1~sid~msg~t', '1~sid~msg~tx', '1~sid~msg~t-1', '1~sid~msg~t99999',
    ]) {
      expect(parseActivityRef(bad), `accepted ${JSON.stringify(bad)}`).toBeNull()
    }
    // A ref long enough to be an attack rather than a row.
    expect(parseActivityRef(`1~sid~${'m'.repeat(600)}~k`)).toBeNull()
  })

  it('rejects a non-string without throwing', () => {
    // The value arrives from a query string, so it can be an array (`?ref=a&ref=b`)
    // or absent entirely; the route must get null, not an exception.
    expect(parseActivityRef(undefined as unknown as string)).toBeNull()
    expect(parseActivityRef(['a', 'b'] as unknown as string)).toBeNull()
  })
})

describe('activity detail sections: what a section says about itself', () => {
  // The numbers a section reports are what a client puts in front of a human
  // ("Showing the first N of M characters."), so each one is pinned in the unit it is
  // actually in. Two shipped defects came from this file getting that wrong, and both
  // are here as their own case.
  const CREDENTIAL = 'aws_secret_access_key=testfixturefakesecretvalue0123456789abcd'

  it('counts a COMPLETE section after masking, not before it', () => {
    // The defect, measured on a device: 6,838 characters of masked result delivered
    // whole, reported as `resultChars: 6999` (the pre-masking source), so the footer
    // named 161 characters that do not exist and no request could ever return.
    // Masking SHRINKS (`AKIA…` becomes `[REDACTED]`), so a source count is not a fact
    // about the text a client can display.
    const source = 'ordinary build output\n'.repeat(40) + CREDENTIAL + '\nDELIVERED-TAIL'
    const section = toolResultFullText(source, 0, { chars: source.length, reachable: true })!
    expect(section.text).toContain('[REDACTED]')
    expect(section.text).toContain('DELIVERED-TAIL')
    // The delivered length IS the total, exactly.
    expect(section.totalChars).toBe(section.text.length)
    // …and that is genuinely a smaller number than the source, which is what makes
    // this test able to fail: with the old rule it was the source length.
    expect(section.totalChars).toBeLessThan(source.trim().length)
    expect(sectionHasMore(section)).toBe(false)
    expect(section.nextOffset).toBeUndefined()
  })

  it('reports the SOURCE length and "there is more" when it holds only a prefix', () => {
    // A partial section cannot know its delivered total — the remainder has not been
    // masked. The source-based estimate is the best available, and `more` is what the
    // client acts on.
    const prefix = 'a'.repeat(HISTORY_TOOL_RESULT_MAX)
    const section = toolResultFullText(prefix, 0, { chars: 24_993, reachable: true })!
    expect(section.text.length).toBe(HISTORY_TOOL_RESULT_MAX)
    expect(section.totalChars).toBe(24_993)
    expect(section.end).toBe(HISTORY_TOOL_RESULT_MAX)
    expect(sectionHasMore(section)).toBe(true)
  })

  it('offers NO cursor when the remainder cannot be fetched', () => {
    // The second defect: when the uncapped row re-read fails, the retained prefix is
    // all there will ever be. A cursor there advertised `offset=4999` on a page that
    // answered 200 with an empty string — the empty-page loop this module's own
    // comment promised was impossible. `reachable` is the flag that decides it, and it
    // is the caller's knowledge, not something this function can infer.
    const prefix = 'b'.repeat(HISTORY_TOOL_RESULT_MAX)
    const unreachable = toolResultFullText(prefix, 0, { chars: 24_993, reachable: false })!
    expect(sectionHasMore(unreachable)).toBe(true)
    expect(unreachable.totalChars).toBe(24_993)
    expect(unreachable.nextOffset).toBeUndefined()

    // Same prefix, same numbers, reachable: the cursor is exactly the boundary.
    const reachable = toolResultFullText(prefix, 0, { chars: 24_993, reachable: true })!
    expect(reachable.nextOffset).toBe(HISTORY_TOOL_RESULT_MAX)
  })

  it('offers a cursor that ADVANCES, or none at all', () => {
    // A cursor equal to the offset it was asked at would make a client that chases
    // `nextOffset` loop forever on an empty page, reachable or not.
    const prefix = 'b'.repeat(100)
    expect(toolResultFullText(prefix, 0, { chars: 900, reachable: true })!.nextOffset).toBe(100)

    const pastTheEnd = toolResultFullText(prefix, 100, { chars: 900, reachable: true })!
    expect(pastTheEnd.text).toBe('')
    expect(pastTheEnd.nextOffset).toBeUndefined()
    expect(sectionHasMore(pastTheEnd)).toBe(true)
  })

  it('does not turn trailing whitespace into a phantom missing tail', () => {
    // Found on real transcripts, not by inspection: `resultChars` counts the source
    // verbatim while a section is trimmed, so a result ending in a newline is one
    // character "short" of its own length. Comparing against the section total made a
    // WHOLE 24,291-character result claim `truncated: true` and hand out a cursor
    // pointing at the newline it had just trimmed — a Show-more button that returns
    // an empty page, on the most ordinary shape a tool result has.
    const whole = 'command output\nsecond line\n\n'
    const section = toolResultFullText(whole, 0, { chars: whole.length, reachable: true })!
    expect(section.text).toBe(whole.trim())
    expect(sectionHasMore(section)).toBe(false)
    expect(section.nextOffset).toBeUndefined()
  })

  it('leaves a whole result exactly as it found it', () => {
    // The no-cap case must stay byte-identical, cursor-free and untruncated — the
    // ordinary result, which is nearly every row.
    const whole = 'ordinary output'
    const section = toolResultFullText(whole, 0, { chars: whole.length, reachable: true })!
    expect(section.text).toBe(whole)
    expect(section.totalChars).toBe(whole.length)
    expect(section.nextOffset).toBeUndefined()
    expect(sectionHasMore(section)).toBe(false)
  })
})
