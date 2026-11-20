/**
 * The selection's "Make a diagram" button keeps clear of an overlay a plugin shows at the bottom
 * of the canvas (web/src/components/drawing/canvas-overlay.ts). 2026-11-20: the walkthrough's
 * caption strip sat at the canvas's bottom 72 to 106 px, and the button, held only above the
 * editor's bottom bar (88 px), could sit on it for a shape near the bottom.
 */
import { describe, expect, it } from 'vitest'
import { overlayRoom, pillTop, type SelectionPill } from '../../web/src/components/drawing/canvas-overlay'

const H = 800
const pill = (y: number, below = false): SelectionPill => ({ x: 400, y, below, height: H })
/** The button's [top, bottom] on the canvas, as the CSS places it (28 px high, translated up unless below). */
const span = (p: SelectionPill, room: number): [number, number] => {
  const top = pillTop(p, room)
  return p.below ? [top, top + 28] : [top - 28, top]
}

describe('the selection button and an overlay at the bottom', () => {
  it('with nothing shown, the button is where the editor put it', () => {
    expect(pillTop(pill(H - 88), 0)).toBe(H - 88)
    expect(pillTop(pill(120, true), 0)).toBe(120)
  })

  it('never reaches into the room the overlay shows in, above or below the selection', () => {
    const room = 106 // the caption strip: bottom 72 px, 34 px high
    for (const p of [pill(H - 88), pill(H - 100), pill(H - 60, true), pill(H - 200, true)]) {
      const [, bottom] = span(p, room)
      expect(bottom).toBeLessThanOrEqual(H - room - 8)
    }
    // Higher up it does not move.
    expect(pillTop(pill(300), room)).toBe(300)
  })

  it('measures the room from what the overlay shows, and nothing shown is none', () => {
    expect(overlayRoom({ bottom: 900 }, [])).toBe(0)
    expect(overlayRoom({ bottom: 900 }, [{ top: 900, height: 0 }])).toBe(0)
    expect(overlayRoom({ bottom: 900 }, [{ top: 794, height: 34 }, { top: 760, height: 34 }])).toBe(140)
  })
})
