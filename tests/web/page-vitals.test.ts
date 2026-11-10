/**
 * web/src/utils/page-vitals.ts: the page's own reading of how much it holds, logged beside the
 * Mac app's memory lines so growth in the window someone really uses can be traced.
 */
import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { readPageVitals, registerPageVital } from '../../web/src/utils/page-vitals'

function page(html: string) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  Object.assign(window, { innerWidth: 2560, innerHeight: 1408, devicePixelRatio: 2, performance: { now: () => 30 * 60_000 } })
  return { document: document as unknown as Document, window: window as unknown as Window }
}

describe('page vitals', () => {
  it('counts what the page holds', () => {
    const { document, window } = page(`
      <div class="session-panel"><div class="session-history"><div class="session-msg">a</div><div class="session-msg">b</div></div></div>
      <div class="session-panel"><div class="session-history"><div class="session-msg">c</div></div></div>
      <img src="x.png"><canvas width="100" height="100"></canvas><svg></svg><iframe></iframe>`)
    const v = readPageVitals(document, window)
    expect(v).toMatchObject({ panels: 2, msgRows: 3, imgs: 1, canvases: 1, svgs: 1, iframes: 1, viewport: '2560x1408@2', ageMin: 30 })
    expect(v.nodes).toBeGreaterThan(10)
    expect(Number.isFinite(v.imgMpx) && Number.isFinite(v.scrollMpx)).toBe(true)
  })

  it('adds a store\'s own probe, and a probe that throws never breaks the sample', () => {
    const { document, window } = page('<div></div>')
    const off = registerPageVital('historyRows', () => 42)
    const bad = registerPageVital('broken', () => { throw new Error('boom') })
    const v = readPageVitals(document, window)
    expect(v.historyRows).toBe(42)
    expect(v.broken).toBeUndefined()
    off(); bad()
    expect(readPageVitals(document, window).historyRows).toBeUndefined()
  })
})
