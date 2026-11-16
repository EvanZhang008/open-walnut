/**
 * Where the agent tab's pill (content.ts showAgentMark: "Walnut agent is using this tab", with
 * Stop) sits so it never lies under a point the agent acts on (page-agent.ts pointAt): the bottom
 * right corner, else the top, else out of sight until a step lets it back. Every point of the
 * last few seconds counts, so the two ends of one drag (or a step looked at twice) never send it
 * back over the other.
 */

/** Points of one action come within this of each other (a drag looks at both ends, then again). */
export const RECENT_MS = 3000
const MARGIN_PX = 6
export const PLACES = ['down', 'up', 'away'] as const
export type Place = typeof PLACES[number]

/** `place` puts the pill there (synchronously, so its box reads true at once); `box` reads it. */
export function wayMaker(box: () => { left: number; top: number; right: number; bottom: number }, place: (p: Place) => void, now = () => Date.now()): (x: number, y: number) => Place | null {
  let at: Place = 'down'
  let recent: Array<{ x: number; y: number; t: number }> = []
  const covers = () => {
    if (at === 'away') return false
    const r = box()
    return recent.some((p) => p.x >= r.left - MARGIN_PX && p.x <= r.right + MARGIN_PX && p.y >= r.top - MARGIN_PX && p.y <= r.bottom + MARGIN_PX)
  }
  return (x, y) => {
    const t = now()
    recent = recent.filter((p) => t - p.t < RECENT_MS)
    recent.push({ x, y, t })
    if (at !== 'away' && !covers()) return null
    // Out of sight only for now: back in its corner, or at the top, as soon as no recent step is there.
    for (const p of PLACES) {
      at = p
      place(p)
      if (!covers()) return p
    }
    return at
  }
}
