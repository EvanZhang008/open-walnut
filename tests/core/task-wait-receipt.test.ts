/**
 * The pure half of a session's park: reading the clock and the report a caller
 * passes, and composing the receipt letter the user gets. The letter must always
 * answer the same three questions (what is watched, when it comes back, how to
 * take it back), whether or not the session wrote an opening.
 */
import { describe, it, expect } from 'vitest'
import {
  WAIT_REPORT_MAX,
  composeWaitReceipt,
  parseWaitReport,
  parseWaitUntil,
} from '../../src/core/task-wait-receipt.js'

const NOW = Date.parse('2026-10-04T12:00:00.000Z')

describe('parseWaitUntil', () => {
  it('reads a duration from now in every unit', () => {
    expect(parseWaitUntil('6h', NOW)).toBe('2026-10-04T18:00:00.000Z')
    expect(parseWaitUntil('3d', NOW)).toBe('2026-10-07T12:00:00.000Z')
    expect(parseWaitUntil('90m', NOW)).toBe('2026-10-04T13:30:00.000Z')
    expect(parseWaitUntil('30s', NOW)).toBe('2026-10-04T12:00:30.000Z')
    expect(parseWaitUntil('1.5h', NOW)).toBe('2026-10-04T13:30:00.000Z')
    expect(parseWaitUntil(' 2D ', NOW)).toBe('2026-10-06T12:00:00.000Z')
    // A bare number is milliseconds, the same as `every`.
    expect(parseWaitUntil(60_000, NOW)).toBe('2026-10-04T12:01:00.000Z')
  })

  it('reads an ISO datetime, offset included, as the same instant', () => {
    expect(parseWaitUntil('2026-10-09T17:00:00-07:00', NOW)).toBe('2026-10-10T00:00:00.000Z')
  })

  it('keeps "no clock" and "not named" apart', () => {
    expect(parseWaitUntil('', NOW)).toBe('')
    expect(parseWaitUntil('   ', NOW)).toBe('')
    expect(parseWaitUntil(undefined, NOW)).toBeUndefined()
    expect(parseWaitUntil(null, NOW)).toBeUndefined()
  })

  it('refuses a clock that is not a time, or not in the future', () => {
    expect(() => parseWaitUntil('next week', NOW)).toThrow(/neither an ISO datetime nor a duration/)
    expect(() => parseWaitUntil('6 weeks', NOW)).toThrow(/neither/)
    expect(() => parseWaitUntil('2026-10-01T00:00:00Z', NOW)).toThrow(/not in the future/)
    expect(() => parseWaitUntil('0h', NOW)).toThrow(/not in the future/)
    expect(() => parseWaitUntil({ at: 'x' }, NOW)).toThrow(/ISO datetime or a duration/)
    expect(() => parseWaitUntil(true, NOW)).toThrow(/ISO datetime or a duration/)
  })
})

describe('parseWaitReport', () => {
  it('trims text and treats blank as none', () => {
    expect(parseWaitReport('  PR 123 is pushed.\n')).toBe('PR 123 is pushed.')
    expect(parseWaitReport('   ')).toBeUndefined()
    expect(parseWaitReport(undefined)).toBeUndefined()
  })

  it('refuses a report that is not text or longer than one phone screen', () => {
    expect(() => parseWaitReport(42)).toThrow(/must be text/)
    expect(parseWaitReport('x'.repeat(WAIT_REPORT_MAX))).toHaveLength(WAIT_REPORT_MAX)
    expect(() => parseWaitReport('x'.repeat(WAIT_REPORT_MAX + 1))).toThrow(/one phone screen/)
  })
})

describe('composeWaitReceipt', () => {
  const until = '2026-10-07T12:00:00.000Z'

  it('leads with the session\'s report and stamps the three facts under it', () => {
    const r = composeWaitReceipt({
      title: 'Ship the menu page',
      waitUntil: until,
      report: 'PR 123 is pushed and CI is green.\nWaiting for the review.',
      triggers: [{ description: 'Checks PR 123 for review comments.', everyMs: 300_000, host: 'devbox' }],
    })
    expect(r.subject).toBe('Waiting: Ship the menu page')
    expect(r.markdown.startsWith('PR 123 is pushed and CI is green.\nWaiting for the review.\n\n---\n\n')).toBe(true)
    expect(r.markdown).toContain('This task is parked: it is off your task list until something happens.')
    expect(r.markdown).toContain('**Watching:**\n- Checks PR 123 for review comments. (every 5 min on devbox)')
    expect(r.markdown).toMatch(/\*\*Back by:\*\* .+ at the latest, even if nothing happens\./)
    expect(r.markdown).toContain('**To take it back now:** send a message in its session.')
    // The preview is the report's first line.
    expect(r.text).toBe('PR 123 is pushed and CI is green.')
  })

  it('still says all three things with no report, no trigger and no clock', () => {
    const r = composeWaitReceipt({ title: 'Wait for the reply', triggers: [] })
    expect(r.markdown.startsWith('This task is parked')).toBe(true)
    expect(r.markdown).not.toContain('---')
    expect(r.markdown).toContain('**Watching:** nothing; only the clock brings it back.')
    expect(r.markdown).toContain('**Back by:** no time limit. Only a trigger firing or your message brings it back.')
    expect(r.text).toBe('Parked until something happens.')
  })

  it('names each trigger by description, then name, and hides the local host', () => {
    const r = composeWaitReceipt({
      title: 't',
      waitUntil: until,
      triggers: [
        { name: 'Deploy watch', everyMs: 3_600_000, host: '__local__' },
        { everyMs: 86_400_000 },
        { description: 'Line one\n  line two', everyMs: 45_000 },
      ],
    })
    expect(r.markdown).toContain('- Deploy watch (every 1h)')
    expect(r.markdown).toContain('- A trigger (every 1d)')
    expect(r.markdown).toContain('- Line one line two (every 45s)')
    expect(r.text).toMatch(/^Parked until .+ at the latest\.$/)
  })

  it('keeps the subject and the preview inside their envelopes', () => {
    const r = composeWaitReceipt({ title: 'x'.repeat(400), report: 'y'.repeat(600), triggers: [] })
    expect(r.subject.length).toBe(200)
    expect(r.text.length).toBe(280)
  })

  it('keeps Unicode in the report intact', () => {
    // Non-ASCII test data: a report written in the user's language (CJK + emoji).
    const report = '\u5df2\u63a8\u9001 PR 123\uff0c\u7b49\u5f85\u8bc4\u5ba1 \u{1F440}'
    const r = composeWaitReceipt({ title: 't', report, triggers: [] })
    expect(r.markdown.startsWith(report)).toBe(true)
    expect(r.text).toBe(report)
  })
})
