/**
 * A cut inside a surrogate pair poisons the WHOLE response.
 *
 * Every excerpt this codebase ships is `slice(0, N)` on a JS string, where N is a
 * UTF-16 code-unit index. An astral character (any emoji, many CJK extension
 * characters) is TWO of those units, so when one straddles a cap the delivered string
 * ends in a lone surrogate. `JSON.stringify` then emits it as a `\udXXX` escape, and a
 * strict decoder (Swift's `JSONDecoder`) rejects the ENTIRE payload: the phone drew an
 * empty conversation, with no error, twice on device. One emoji on one row of a
 * hundred-row page is enough.
 *
 * So each case here puts an emoji EXACTLY on a documented cap and asserts three
 * things about what comes out:
 *
 *  1. no lone surrogate (the regex from the report, checked on the string itself);
 *  2. no `\udXXX` escape in the serialized form. This is the assertion that matters
 *     and the one a naive test misses: well-formed `JSON.stringify` ESCAPES a lone
 *     surrogate rather than emitting it, so the poison is invisible in the string
 *     comparison and perfectly visible to the client that has to decode it;
 *  3. the delivered text is a valid prefix of the source, i.e. the fix drops the split
 *     character rather than half of it, and never invents one.
 *
 * Vacuity guard, since a test built on a cap can rot into asserting nothing: where the
 * arithmetic is deterministic the case also pins the output LENGTH at cap-1 (+ the
 * ellipsis). Only a boundary-safe cut is one character short, so that number is the
 * proof the pair was really straddling the cap and the snap really ran.
 *
 * Real code throughout: the shipped excerpt/section functions, the real JSONL parse
 * (parseSessionMessages), the real transcript clip and the real projection row.
 */
import { describe, it, expect } from 'vitest'
import { cutEnd, cutStart } from '../../src/core/text-cut.js'
import {
  toolDetail, toolInputPreview, toolResultPreview, thinkingLine, thinkingExcerpt,
  thinkingFullText, toolInputFullText, toolResultFullText,
  thinkingHasFullText, toolHasFullText, FULL_TEXT_SECTION_MAX,
} from '../../src/core/tool-summary.js'
import { clipTranscriptText, TRANSCRIPT_TEXT_MAX, TRANSCRIPT_RICH_TEXT_MAX } from '../../src/core/sessions/transcript-clip.js'
import { parseSessionMessages, HISTORY_TOOL_RESULT_MAX } from '../../src/core/session-history.js'
import { projectSession } from '../../src/core/session-projection.js'
import type { SessionRecord } from '../../src/core/types.js'

/** The report's own detector: a high surrogate with no low after it, or the reverse. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

/** U+1F600, i.e. two UTF-16 code units — the shape of the field report. */
const EMOJI = '\u{1F600}'

/** Documented caps the cases below aim at (api-v1.md / tool-summary.ts). */
const DETAIL_MAX = 160
const RESULT_PREVIEW_MAX = 700
const THINKING_EXCERPT_MAX = 2_000
const INPUT_PREVIEW_MAX = 2_000
const INPUT_PREVIEW_VALUE_MAX = 1_000
const DESCRIPTION_MAX = 300

/** Text whose emoji STRADDLES `cap`: its high half is the cap's last unit. */
const straddle = (cap: number, fill = 'a', tail = 200): string =>
  fill.repeat(cap - 1) + EMOJI + fill.repeat(tail)

/** Everything a delivered string has to satisfy, in one place. */
function assertDeliverable(label: string, value: string | undefined, source?: string): void {
  expect(value, `${label}: nothing delivered`).toBeTypeOf('string')
  const text = value!
  expect(LONE_SURROGATE.test(text), `${label}: lone surrogate in the delivered text`).toBe(false)
  const json = JSON.stringify({ text })
  // The load-bearing one. A lone surrogate survives `JSON.stringify` as an escape, so
  // this is what the phone's decoder actually chokes on. The lookbehind matters: text
  // that literally spells `\ud83d` (this repo's own sessions discuss surrogates) is
  // serialized as `\\ud83d`, and a pattern without it reads that as the poison.
  expect(json, `${label}: escaped lone surrogate in the JSON`).not.toMatch(/(?<!\\)\\u[dD][89abAB]/)
  expect(JSON.parse(json)).toEqual({ text })
  if (source !== undefined) {
    const delivered = text.endsWith('…') ? text.slice(0, -1) : text
    expect(source.startsWith(delivered), `${label}: delivered text is not a prefix of the source`).toBe(true)
  }
}

describe('cut helpers: the index moves, the unit does not', () => {
  const s = `a${EMOJI}b` // a, high, low, b — length 4

  it('moves an end cut back to the boundary and a start cut forward', () => {
    expect(cutEnd(s, 2)).toBe(1) // between the halves → before the pair
    expect(cutStart(s, 2)).toBe(3) // between the halves → after the pair
    // Every index that is already a boundary is left exactly alone.
    for (const i of [0, 1, 3, 4]) {
      expect(cutEnd(s, i)).toBe(i)
      expect(cutStart(s, i)).toBe(i)
    }
  })

  it('clamps instead of throwing, and never treats a paired index as split', () => {
    expect(cutEnd(s, -5)).toBe(0)
    expect(cutStart(s, 99)).toBe(s.length)
    // A high surrogate NOT followed by a low (already-broken source data) is left as
    // it is: this fixes cuts, it does not launder input.
    const broken = `x\uD83Dy`
    expect(cutEnd(broken, 2)).toBe(2)
  })
})

describe('excerpt caps: an emoji sitting on the cap', () => {
  it('keeps the collapsed 160-char one-liners clean (thinking + tool detail)', () => {
    const source = straddle(DETAIL_MAX)
    const line = thinkingLine(source)
    assertDeliverable('thinkingLine', line, source)
    expect(line.length).toBe(DETAIL_MAX) // 159 kept + the ellipsis: one short = snapped

    const detail = toolDetail('Bash', { command: source })
    assertDeliverable('toolDetail', detail, source)
    expect(detail!.length).toBe(DETAIL_MAX)
  })

  it('keeps the 700-char result preview clean', () => {
    const source = straddle(RESULT_PREVIEW_MAX)
    const preview = toolResultPreview(source)
    assertDeliverable('toolResultPreview', preview, source)
    expect(preview!.length).toBe(RESULT_PREVIEW_MAX)
  })

  it('keeps the 2000-char thinking excerpt clean', () => {
    const source = straddle(THINKING_EXCERPT_MAX)
    const excerpt = thinkingExcerpt(source)
    assertDeliverable('thinkingExcerpt', excerpt, source)
    expect(excerpt!.length).toBe(THINKING_EXCERPT_MAX)
  })

  it('keeps a per-value input clip clean (the 1000-char cap inside a line)', () => {
    const source = straddle(INPUT_PREVIEW_VALUE_MAX)
    const preview = toolInputPreview({ command: source })
    assertDeliverable('toolInputPreview value', preview)
    // `command: ` + 999 kept + the ellipsis.
    expect(preview!.length).toBe('command: '.length + INPUT_PREVIEW_VALUE_MAX)
    expect(preview!.startsWith(`command: ${source.slice(0, INPUT_PREVIEW_VALUE_MAX - 1)}`)).toBe(true)
  })

  it('keeps the 2000-char joined input clip clean (the cut lands in a later value)', () => {
    // Three values, each inside the per-value cap, whose JOINED render puts the emoji
    // on the 2000th unit — so only the join's own cut can split it.
    const a = 'a'.repeat(900)
    const b = 'b'.repeat(900)
    const prefixLen = `a: ${a}\nb: ${b}\nc: `.length
    const c = 'c'.repeat(INPUT_PREVIEW_MAX - 1 - prefixLen) + EMOJI + 'c'.repeat(300)
    expect(c.length).toBeLessThan(INPUT_PREVIEW_VALUE_MAX)
    const joined = `a: ${a}\nb: ${b}\nc: ${c}`
    // The construction really does straddle: unit 2000 is the emoji's low half.
    expect(joined.charCodeAt(INPUT_PREVIEW_MAX)).toBeGreaterThanOrEqual(0xdc00)

    const preview = toolInputPreview({ a, b, c })
    assertDeliverable('toolInputPreview join', preview, joined)
    expect(preview!.length).toBe(INPUT_PREVIEW_MAX)
  })

  it('still advertises a fuller read when the emoji ate the cap', () => {
    // The regression the boundary snap can cause if "did I cut" is re-derived from the
    // length: a clipped excerpt comes back one character SHORT of the cap, reads as
    // whole, and the row drops its `detailRef` — the tail becomes unreachable with no
    // error anywhere. Both predicates therefore read the producer's own flag.
    expect(thinkingHasFullText(straddle(THINKING_EXCERPT_MAX))).toBe(true)
    expect(toolHasFullText({}, straddle(RESULT_PREVIEW_MAX))).toBe(true)
    expect(toolHasFullText({ command: straddle(INPUT_PREVIEW_VALUE_MAX) }, 'ok')).toBe(true)
    // …and a row that fits still advertises nothing (the flag did not become a yes-man).
    expect(thinkingHasFullText(`short reasoning ${EMOJI}`)).toBe(false)
    expect(toolHasFullText({ command: `echo ${EMOJI}` }, `ok ${EMOJI}`)).toBe(false)
  })
})

describe('full-text sections: paging never splits a character', () => {
  it('cuts the 200,000-unit window on a boundary and hands back a cursor that joins', () => {
    const source = straddle(FULL_TEXT_SECTION_MAX, 'a', 500)
    const first = thinkingFullText(source)!
    assertDeliverable('page 1', first.text, source)
    // One short of the window: the emoji went to the next page whole.
    expect(first.text.length).toBe(FULL_TEXT_SECTION_MAX - 1)
    expect(first.nextOffset).toBe(FULL_TEXT_SECTION_MAX - 1)

    const second = thinkingFullText(source, first.nextOffset!)!
    assertDeliverable('page 2', second.text)
    expect(second.text.startsWith(EMOJI)).toBe(true)
    // The seam holds: the pages join back into the source, nothing dropped or doubled.
    expect(first.text + second.text).toBe(source)
    expect(second.nextOffset).toBeUndefined()
  })

  it('adjusts an offset a client picked in the middle of a character', () => {
    // `offset=700` on text whose emoji sits at 699 would begin with a lone LOW
    // surrogate — the same poison at the other end of the window.
    const source = 'x'.repeat(699) + EMOJI + 'y'.repeat(1_000)
    const mid = thinkingFullText(source, 700)!
    assertDeliverable('offset mid-pair', mid.text)
    expect(mid.text.startsWith('y')).toBe(true) // the split character is dropped, not halved
    // The boundary offsets around it behave the obvious way.
    expect(thinkingFullText(source, 699)!.text.startsWith(EMOJI)).toBe(true)
    expect(thinkingFullText(source, 701)!.text.startsWith('y')).toBe(true)
  })

  it('keeps every section of a tool row clean at offsets 0, 700 and 2000', () => {
    const result = straddle(RESULT_PREVIEW_MAX, 'r', 3_000)
    const input = { command: straddle(INPUT_PREVIEW_VALUE_MAX, 'i', 3_000) }
    for (const offset of [0, RESULT_PREVIEW_MAX, THINKING_EXCERPT_MAX]) {
      assertDeliverable(`result @${offset}`, toolResultFullText(result, offset)!.text)
      assertDeliverable(`input @${offset}`, toolInputFullText(input, offset)!.text)
    }
    // A result whose remainder is only reachable through the re-read path (the
    // `source` arm) is the same story: the window is still cut on a boundary.
    const capped = result.slice(0, cutEnd(result, HISTORY_TOOL_RESULT_MAX))
    const section = toolResultFullText(capped, 0, { chars: result.length + 9_000, reachable: true })!
    assertDeliverable('capped result', section.text)
    expect(section.more).toBe(true)
  })
})

describe('the other cuts on the same wire', () => {
  it('keeps the retained tool result clean at HISTORY_TOOL_RESULT_MAX', () => {
    const source = straddle(HISTORY_TOOL_RESULT_MAX, 'z', 500)
    const jsonl = [
      JSON.stringify({
        type: 'assistant', uuid: 'a-1', timestamp: '2026-09-12T00:00:00.000Z',
        message: {
          id: 'msg_1', role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'run' } }],
        },
      }),
      JSON.stringify({
        type: 'user', uuid: 'u-1', timestamp: '2026-09-12T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: source }] },
      }),
    ].join('\n')

    const tool = parseSessionMessages(jsonl).flatMap((m) => m.tools ?? []).find((t) => t.toolUseId === 'toolu_1')!
    assertDeliverable('retained tool result', tool.result, source)
    expect(tool.result!.length).toBe(HISTORY_TOOL_RESULT_MAX - 1)
    // The count still measures the SOURCE in UTF-16 code units, so the detail read
    // knows there is more.
    expect(tool.resultChars).toBe(source.length)
  })

  it('keeps a clipped transcript row clean, prose and markup alike', () => {
    const prose = straddle(TRANSCRIPT_TEXT_MAX, 'p', 500)
    const clippedProse = clipTranscriptText(prose)
    assertDeliverable('transcript prose clip', clippedProse, prose)
    expect(clippedProse.length).toBe(TRANSCRIPT_TEXT_MAX)

    // The rich budget is the same cut one constant over. `<b>x</b>` makes it markup.
    const head = '<b>rich</b> '
    const markup = head + straddle(TRANSCRIPT_RICH_TEXT_MAX - head.length, 'm', 500)
    const clippedMarkup = clipTranscriptText(markup)
    assertDeliverable('transcript markup clip', clippedMarkup, markup)
    expect(clippedMarkup.length).toBe(TRANSCRIPT_RICH_TEXT_MAX)
  })

  it('keeps a projected session description clean', () => {
    const description = straddle(DESCRIPTION_MAX, 'd', 200)
    const row = projectSession({
      claudeSessionId: 's-1', process_status: 'idle', description,
      startedAt: '2026-09-12T00:00:00.000Z', lastActiveAt: '2026-09-12T00:00:00.000Z',
    } as SessionRecord, undefined)
    assertDeliverable('projected description', row.description, description)
    expect(row.description!.length).toBe(DESCRIPTION_MAX)
  })
})
