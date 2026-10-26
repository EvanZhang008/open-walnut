/** When a wait on a lead wakes it (src/core/org/lead-waits.ts wakeAt), pure. */
import { describe, it, expect } from 'vitest'
import { wakeAt } from '../../../src/core/org/lead-waits.js'

const turnEnd = '2026-10-26T12:00:00.000Z'

describe('lead wait wake time', () => {
  it('a wait the turn itself named wakes the lead at once', () => {
    expect(wakeAt({ status_report: { state: 'done', at: turnEnd } as never, last_session_update: turnEnd })).toBe(0)
    expect(wakeAt({ status_report: { state: 'waiting', waiting_kind: 'lead', at: turnEnd } as never, last_session_update: turnEnd })).toBe(0)
  })

  it('a report of the turn before speaks for nothing', () => {
    // The last turn said done; a new turn ended later and its report has not come yet.
    const moved = '2026-10-26T12:30:00.000Z'
    const stale = { status_report: { state: 'done', at: turnEnd } as never, phase_changed_at: moved, last_session_update: moved }
    expect(wakeAt(stale)).toBe(Date.parse(moved) + 10 * 60_000)
    // Its own report, a few seconds before the phase write (another process's clock), counts.
    expect(wakeAt({ ...stale, status_report: { state: 'done', at: '2026-10-26T12:29:57.000Z' } as never })).toBe(0)
  })

  it('a wait with no report behind it wakes only once the report had time to come', () => {
    expect(wakeAt({ last_session_update: turnEnd })).toBe(Date.parse(turnEnd) + 10 * 60_000)
    // A report about something else (it waits on the user) is not a wait on the lead.
    expect(wakeAt({ status_report: { state: 'waiting', waiting_kind: 'you', at: turnEnd } as never, last_session_update: turnEnd }))
      .toBe(Date.parse(turnEnd) + 10 * 60_000)
  })
})
