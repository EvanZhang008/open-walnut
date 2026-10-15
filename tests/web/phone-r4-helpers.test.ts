/**
 * Pure rules behind the round-four phone fixes: when a pending prompt card
 * counts as seen (R3-01, R3-08, N2-11) and where a phone's day opens (R3-06).
 */
import { describe, expect, it } from 'vitest'
import { promptCardSeen } from '../../web/src/components/sessions/PhoneTimelinePills'
import { GRID_FOCUS_START, PHONE_MIN_SLOT_PX, phoneLandingMinute } from '../../web/src/components/calendar/calendar-grid-settings'

const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

describe('promptCardSeen', () => {
  const box = rect(44, 492)
  it('is seen when its last button is in the timeline', () => {
    expect(promptCardSeen(rect(300, 170), rect(420, 44), box)).toBe(true)
  })
  it('is not seen when only its head shows at the bottom (N2-11)', () => {
    expect(promptCardSeen(rect(496, 170), rect(616, 44), box)).toBe(false)
  })
  it('is seen when it fills the timeline, buttons below the fold (R3-08)', () => {
    expect(promptCardSeen(rect(-200, 900), rect(650, 44), box)).toBe(true)
  })
  it('is seen when half of it shows', () => {
    expect(promptCardSeen(rect(400, 200), rect(560, 44), box)).toBe(true)
  })
  it('is not seen when it is scrolled away above', () => {
    expect(promptCardSeen(rect(-400, 170), rect(-280, 44), box)).toBe(false)
  })
})

describe('phoneLandingMinute', () => {
  const now = new Date(2026, 9, 14, 13, 30)
  it('opens an hour before now on a day that includes today', () => {
    expect(phoneLandingMinute(['2026-10-14'], now)).toBe(12 * 60 + 30)
  })
  it('opens at the work day start on another day', () => {
    expect(phoneLandingMinute(['2026-10-15'], now)).toBe(GRID_FOCUS_START)
  })
  it('never opens before midnight', () => {
    expect(phoneLandingMinute(['2026-10-14'], new Date(2026, 9, 14, 0, 20))).toBe(0)
  })
  it('keeps an hour at 52 px or more', () => {
    expect(PHONE_MIN_SLOT_PX * 2).toBeGreaterThanOrEqual(52)
  })
})
