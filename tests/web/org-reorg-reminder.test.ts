/**
 * The Org page's reorg reminder (web/src/components/org/org-reorg-reminder.ts; 2026-11-12, the
 * user: "if the VP more than 6 remind them to do reorg, if they select close we keep remind each
 * one more vp created, like remind in 6, 7, 8 but if they close, we at least don't remind in
 * current load, they can also choose never remind").
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  REORG_CLOSED_KEY, REORG_NEVER_KEY, REORG_NEVER_VALUE, REORG_REMIND_AT, _resetReorgReminderForTests, closeReorgReminder, reorgClosedAt,
  reorgClosedFrom, reorgLine, reorgNeverFrom, showReorgReminder,
} from '../../web/src/components/org/org-reorg-reminder.js'
import { syncableKey } from '../../src/core/ui-prefs-keys.js'

beforeEach(() => _resetReorgReminderForTests())

describe('when the reminder shows', () => {
  it('from 6 VPs, never below', () => {
    expect(REORG_REMIND_AT).toBe(6)
    expect(showReorgReminder(5, false, null)).toBe(false)
    expect(showReorgReminder(6, false, null)).toBe(true)
    expect(showReorgReminder(7, false, null)).toBe(true)
    expect(showReorgReminder(8, false, null)).toBe(true)
  })

  it('Close hides it for this load until one more VP is made: 6 closed, 7 shows, 7 closed, 8 shows', () => {
    expect(reorgClosedAt()).toBeNull()
    let closedAt = closeReorgReminder(6)
    expect(showReorgReminder(6, false, closedAt)).toBe(false)
    // A VP removed and made again is no new VP.
    expect(showReorgReminder(5, false, closedAt)).toBe(false)
    expect(showReorgReminder(6, false, closedAt)).toBe(false)
    expect(showReorgReminder(7, false, closedAt)).toBe(true)
    closedAt = closeReorgReminder(7)
    expect(showReorgReminder(7, false, closedAt)).toBe(false)
    expect(showReorgReminder(8, false, closedAt)).toBe(true)
  })

  it('the close is kept past the page load: a reload at the same count stays closed (2026-11-23)', () => {
    const store = new Map<string, string>()
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
    const was = (globalThis as { localStorage?: unknown }).localStorage
    ;(globalThis as { localStorage?: unknown }).localStorage = ls
    try {
      closeReorgReminder(8)
      expect(store.get(REORG_CLOSED_KEY)).toBe('8')
      // A lower count closed later never lowers it.
      closeReorgReminder(6)
      expect(reorgClosedAt()).toBe(8)
      // A new load: memory is gone, the kept count still holds.
      _resetReorgReminderForTests()
      expect(reorgClosedAt()).toBe(8)
      expect(showReorgReminder(8, false, reorgClosedAt())).toBe(false)
      expect(showReorgReminder(9, false, reorgClosedAt())).toBe(true)
    } finally {
      ;(globalThis as { localStorage?: unknown }).localStorage = was
    }
  })

  it('the kept close count reads only a whole positive number', () => {
    expect(reorgClosedFrom('6')).toBe(6)
    for (const v of [null, undefined, '', '0', '-2', '6.5', 'six']) expect(reorgClosedFrom(v)).toBeNull()
  })

  it('Never remind me turns it off at every count, closed or not', () => {
    for (const n of [5, 6, 7, 8, 40]) {
      expect(showReorgReminder(n, true, null)).toBe(false)
      expect(showReorgReminder(n, true, 6)).toBe(false)
    }
  })
})

describe('the stored choice', () => {
  it('only the never value turns it off', () => {
    expect(reorgNeverFrom(REORG_NEVER_VALUE)).toBe(true)
    for (const v of [null, undefined, '', 'true', 'Never', '1']) expect(reorgNeverFrom(v)).toBe(false)
  })

  it('is a ui-prefs key the server keeps (synced across devices, kept apart for a test run)', () => {
    expect(syncableKey(REORG_NEVER_KEY)).toBe(true)
    expect(syncableKey(REORG_CLOSED_KEY)).toBe(true)
  })

  it('the line names the count in plain words', () => {
    expect(reorgLine(7)).toBe('You have 7 VPs. Merging some keeps the org easy to follow.')
  })
})
