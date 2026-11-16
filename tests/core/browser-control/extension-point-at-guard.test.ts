/**
 * Walnut's own furniture never takes an agent's step (packages/browser-extension/src/page-agent.ts
 * pointAt). 2026-11-16, in the person's Chrome: the agent tab's pill ("Walnut agent is using this
 * tab", with Stop), wide with its task's name, lay over a page's link; the agent's hover there was
 * refused as covered, and a real click there would have pressed Stop. Now everything of Walnut's
 * at the point moves away first (content.ts showAgentMark moves the pill to the other end).
 *
 * The class: every place the extension asks what is at a point. The ratchet enumerates them from
 * the source, so a new one that calls the browser's hit test itself fails here.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installFakePage } from './page-dom-fake'

const page = installFakePage()
const pa = await import('../../../packages/browser-extension/src/page-agent')
const { wayMaker, RECENT_MS } = await import('../../../packages/browser-extension/src/mark-way')

const SRC = join(__dirname, '../../../packages/browser-extension/src')

describe('every point an agent acts on goes through pointAt', () => {
  it('only page-agent.ts calls the browser\'s hit test, once for a step (pointAt) and once for a look (pageAt)', () => {
    const calls: string[] = []
    for (const f of readdirSync(SRC).filter((n) => /\.tsx?$/.test(n))) {
      const lines = readFileSync(join(SRC, f), 'utf8').split('\n')
      lines.forEach((l, i) => { if (/\belements?FromPoint\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) calls.push(`${f}:${i + 1}`) })
    }
    expect(calls.map((c) => c.replace(/:\d+$/, ''))).toEqual(['page-agent.ts', 'page-agent.ts'])
  })
})

describe('Walnut\'s furniture moves out of the agent\'s way', () => {
  it('a step at the pill moves it first, so the step lands on the page and is not refused as covered', () => {
    page.load('<button id="go">Learn more</button><div id="pill">Walnut agent is using this tab<button id="stop">Stop</button></div>')
    page.place('#go', { x: 460, y: 520, w: 80, h: 20 })
    const pill = page.place('#pill', { x: 430, y: 515, w: 560, h: 32 }, { fixed: true })
    page.place('#stop', { x: 940, y: 520, w: 40, h: 22 }, { fixed: true })
    const seen: Array<[number, number]> = []
    const off = pa.makeWayFor(pill, (x, y) => { seen.push([x, y]); page.place(pill, { x: 430, y: 14, w: 560, h: 32 }, { fixed: true }) })
    try {
      const ref = pa.refFor(document.querySelector('#go')!)
      const t = pa.target({ ref })
      expect(t.el.id).toBe('go')
      expect(seen).toEqual([[t.x, t.y]])
      // A step at a point names the page's element too, never Walnut's.
      expect(pa.target({ x: 470, y: 525 }).el.id).toBe('go')
    } finally { off() }
    // Once its owner is gone it is asked no more.
    page.place(pill, { x: 430, y: 515, w: 560, h: 32 }, { fixed: true })
    expect(pa.pointAt(470, 525)?.id).toBe('pill')
  })

  it('a look (annotate) sees the page under the furniture that makes way, moves nothing, and anything else of Walnut\'s still covers', () => {
    page.load('<button id="go">Learn more</button><div id="pill">pill</div><button id="low">Low</button><div id="savebar">Save?</div>')
    page.place('#go', { x: 460, y: 520, w: 80, h: 20 })
    const pill = page.place('#pill', { x: 430, y: 515, w: 560, h: 32 }, { fixed: true })
    page.place('#low', { x: 20, y: 700, w: 80, h: 20 })
    page.place('#savebar', { x: 0, y: 690, w: 300, h: 40 }, { fixed: true })
    let moved = 0
    const off = pa.makeWayFor(pill, () => { moved++ })
    try {
      expect(pa.pageAt(470, 525)?.id).toBe('go')
      expect(pa.pageAt(30, 705)?.id).toBe('savebar')
      expect(moved).toBe(0)
    } finally { off() }
  })
})

describe('where the pill goes (mark-way.ts)', () => {
  // The pill's box in each place: bottom right, or the same width at the top.
  const BOX = { down: { left: 430, top: 528, right: 990, bottom: 560 }, up: { left: 430, top: 14, right: 990, bottom: 46 } }
  const setup = () => {
    let at: 'down' | 'up' | 'away' = 'down'
    let t = 0
    const go = wayMaker(() => (at === 'away' ? { left: 0, top: 0, right: 0, bottom: 0 } : BOX[at]), (p) => { at = p }, () => t)
    return { go, at: () => at, later: (ms: number) => { t += ms } }
  }

  it('a step elsewhere leaves it in its corner; a step at it sends it to the top', () => {
    const w = setup()
    expect(w.go(100, 100)).toBeNull()
    expect(w.at()).toBe('down')
    w.go(500, 540)
    expect(w.at()).toBe('up')
  })

  it('the two ends of one drag, one under each place, put it out of sight; never back over the start', () => {
    const w = setup()
    w.go(500, 540) // the start, under the corner
    w.go(600, 30) // the end, where the top would be
    expect(w.at()).toBe('away')
    // The drag looks at both ends again (agent-drag.ts points(true)): it stays out of the way.
    w.go(500, 540); w.go(600, 30)
    expect(w.at()).toBe('away')
  })

  it('once those steps are past, the next step elsewhere brings it back to its corner', () => {
    const w = setup()
    w.go(500, 540); w.go(600, 30)
    w.later(RECENT_MS + 1)
    w.go(100, 100)
    expect(w.at()).toBe('down')
  })
})
