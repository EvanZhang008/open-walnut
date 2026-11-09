/**
 * The arithmetic behind an agent's wheel, typing one key at a time, an annotated screenshot's
 * labels and a zoom (packages/browser-extension/src/input-math.ts), as tables: no browser needed.
 */
import { describe, expect, it } from 'vitest'
import { SLOW_KEY_MS, SLOW_MAX, WHEEL_SCREEN_PX, layoutLabels, wheelDelta, zoomCrop } from '../../../packages/browser-extension/src/input-math'

describe('the wheel of a trusted scroll', () => {
  const cases: Array<[string, Record<string, unknown>, { x: number; y: number; said: string }]> = [
    ['down one screen by default', {}, { x: 0, y: WHEEL_SCREEN_PX, said: `down ${WHEEL_SCREEN_PX} px` }],
    ['up two screens', { direction: 'up', amount: 2 }, { x: 0, y: -2 * WHEEL_SCREEN_PX, said: `up ${2 * WHEEL_SCREEN_PX} px` }],
    ['right by pixels', { direction: 'right', by: 240 }, { x: 240, y: 0, said: 'right 240 px' }],
    ['left by pixels', { direction: 'left', by: 90 }, { x: -90, y: 0, said: 'left 90 px' }],
    ['to the top', { to: 'top' }, { x: 0, y: -100_000, said: 'to the top' }],
    ['to the bottom', { to: 'bottom', direction: 'up' }, { x: 0, y: 100_000, said: 'to the bottom' }],
    ['screens are capped at 20', { amount: 99 }, { x: 0, y: 20 * WHEEL_SCREEN_PX, said: `down ${20 * WHEEL_SCREEN_PX} px` }],
    ['pixels are capped', { by: 9_999_999 }, { x: 0, y: 100_000, said: 'down 100000 px' }],
  ]
  for (const [name, args, want] of cases) it(name, () => expect(wheelDelta(args)).toEqual(want))
})

describe('typing slowly', () => {
  it('fits inside one command: the longest text at its pace stays well under 20 s', () => {
    expect(SLOW_MAX * SLOW_KEY_MS).toBeLessThanOrEqual(12_000)
  })
})

describe('the labels of an annotated screenshot', () => {
  const box = (label: number, x: number, y: number, w = 40, h = 20) => ({ label, ref: `e${label}`, role: 'button', name: `B${label}`, x, y, w, h })

  it('scales each box to the picture\'s pixels, its tag above the box when there is room', () => {
    const [a] = layoutLabels([box(3, 100, 50)], 2, 2000, 1600)
    expect(a.box).toEqual({ x: 200, y: 100, w: 80, h: 40 })
    expect(a.tag).toEqual({ x: 200, y: 100 - 28, w: 30, h: 28 })
  })

  it('a box at the top edge has its tag inside it; one at the right edge keeps its tag in the picture', () => {
    const [top, right] = layoutLabels([box(1, 10, 0), box(12, 990, 300, 10, 10)], 1, 1000, 800)
    expect(top.tag.y).toBe(0)
    expect(right.tag.x + right.tag.w).toBeLessThanOrEqual(1000)
  })

  it('a box partly off screen is clipped to the picture for its tag, never placed outside', () => {
    const [l] = layoutLabels([box(5, -30, 790, 60, 40)], 1, 1000, 800)
    expect(l.tag.x).toBe(0)
    expect(l.tag.y + l.tag.h).toBeLessThanOrEqual(800)
  })

  it('a scale that is not a number counts as one', () => {
    const [l] = layoutLabels([box(1, 10, 30)], Number.NaN, 500, 500)
    expect(l.box).toEqual({ x: 10, y: 30, w: 40, h: 20 })
  })
})

describe('the crop of a zoom', () => {
  it('takes the region at the picture\'s own resolution (two device pixels per CSS pixel here)', () => {
    expect(zoomCrop({ x: 100, y: 40, width: 300, height: 200 }, 1280, 2560, 1600)).toEqual({ sx: 200, sy: 80, sw: 600, sh: 400, scale: 2 })
  })

  it('clips a region that runs past the screen, and finds nothing for one wholly off it', () => {
    expect(zoomCrop({ x: 1200, y: 700, width: 400, height: 400 }, 1280, 1280, 800)).toEqual({ sx: 1200, sy: 700, sw: 80, sh: 100, scale: 1 })
    expect(zoomCrop({ x: 2000, y: 0, width: 50, height: 50 }, 1280, 1280, 800)).toBeNull()
    expect(zoomCrop({ x: -10, y: -10, width: 20, height: 20 }, 1280, 1280, 800)).toEqual({ sx: 0, sy: 0, sw: 10, sh: 10, scale: 1 })
  })

  it('keeps fractional CSS pixels whole on the picture (rounding outward)', () => {
    expect(zoomCrop({ x: 10.4, y: 10.6, width: 5.2, height: 5.2 }, 1000, 1500, 900)).toEqual({ sx: 15, sy: 15, sw: 9, sh: 9, scale: 1.5 })
  })
})
