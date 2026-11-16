/**
 * Two pure helpers of the notification panel's host rows:
 *   Tab trap   the panel moves focus on every Tab (WebKit skips buttons in its own order; C42, C25)
 *   landing    Open Settings on a host row lands that row in the upper part of the pane (N3-2)
 */
import { describe, expect, it } from 'vitest'
import { nextTabStop } from '../../web/src/hooks/useDialogFocus'
import { LAND_FRACTION, landingScrollTop } from '../../web/src/utils/scroll-land'

describe('the notification panel Tab trap (C42, C25)', () => {
  const el = (order: number) => ({ order, compareDocumentPosition: (o: { order: number }) => (o.order > order ? 4 : 2) })
  const stops = [el(1), el(2), el(3)] as unknown as HTMLElement[]

  it('moves on every Tab, middle included (WebKit would skip the rail buttons)', () => {
    expect(nextTabStop(stops, stops[0], false)).toBe(stops[1])
    expect(nextTabStop(stops, stops[1], true)).toBe(stops[0])
  })

  it('wraps at both ends', () => {
    expect(nextTabStop(stops, stops[2], false)).toBe(stops[0])
    expect(nextTabStop(stops, stops[0], true)).toBe(stops[2])
  })

  it('from nowhere (focus lost): the first stop, or the last going back', () => {
    expect(nextTabStop(stops, null, false)).toBe(stops[0])
    expect(nextTabStop(stops, null, true)).toBe(stops[2])
    expect(nextTabStop([], null, false)).toBeNull()
  })
})

describe('Open Settings lands in the upper part of the pane (N3-2)', () => {
  it('the row top ends at a fifth of the pane height', () => {
    // An 800px pane, the row 732px down, unscrolled: scroll so its top is at 160.
    expect(landingScrollTop(0, 732, 800, 5000)).toBe(732 - Math.round(800 * LAND_FRACTION))
    expect(landingScrollTop(0, 732, 800, 5000)).toBe(572)
  })

  it('never past either end of the scroll range', () => {
    expect(landingScrollTop(0, 50, 800, 5000)).toBe(0)
    expect(landingScrollTop(0, 900, 800, 300)).toBe(300)
  })

  it('late layout that pushed the row down is corrected from where the pane already is', () => {
    // Already scrolled 572 and the row now reads 268px down (content above it grew 108px): 108 more.
    expect(landingScrollTop(572, 268, 800, 5000)).toBe(680)
  })
})
