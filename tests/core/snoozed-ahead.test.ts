/**
 * snoozedAhead (src/core/user-status.ts): a page reads a snooze it just wrote as one at once,
 * as the server's next status pass will (snoozeOf), and never one the server would not make.
 */
import { describe, expect, it } from 'vitest'
import { snoozedAhead } from '../../src/core/user-status'

const now = Date.parse('2026-11-04T12:00:00Z')
const later = '2026-11-04T14:00:00Z'
const needs = { state: 'needs' as const, source: 'session' as const }

describe('snoozedAhead', () => {
  it('a Needs you whose own start time is still to come reads as snoozed', () => {
    expect(snoozedAhead(needs, later, false, now)).toBe(true)
  })
  it('not a start time already past, nor none', () => {
    expect(snoozedAhead(needs, '2026-11-04T11:00:00Z', false, now)).toBe(false)
    expect(snoozedAhead(needs, '', false, now)).toBe(false)
    expect(snoozedAhead(needs, undefined, false, now)).toBe(false)
  })
  it('not a bare day: its midnight is the page\'s or the server\'s, which may differ', () => {
    expect(snoozedAhead(needs, '2026-11-05', false, now)).toBe(false)
  })
  it('never what a snooze leaves alone: Main, a live prompt, work in progress, one marked already', () => {
    expect(snoozedAhead(needs, later, true, now)).toBe(false)
    expect(snoozedAhead({ state: 'needs', source: 'prompt' }, later, false, now)).toBe(false)
    expect(snoozedAhead({ state: 'working' } as never, later, false, now)).toBe(false)
    expect(snoozedAhead({ ...needs, snoozed: { until: later } }, later, false, now)).toBe(false)
  })
})
