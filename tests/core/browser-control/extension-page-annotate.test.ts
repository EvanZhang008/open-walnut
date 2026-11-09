/**
 * The page's part of an annotated screenshot (packages/browser-extension/src/page-annotate.ts),
 * run for real against a small DOM (page-dom-fake.ts): what a person could act on and see now,
 * numbered top to bottom (hidden, covered and off-screen elements left out, at most 150), and a
 * number standing for its element until the next annotated screenshot (`click {label}`).
 * And the background's drawing of the numbers and a zoom's crop
 * (packages/browser-extension/src/agent-picture.ts), against a fake OffscreenCanvas.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { installFakePage } from './page-dom-fake'

const page = installFakePage()
const pa = await import('../../../packages/browser-extension/src/page-agent')
const { annotate, refOfLabel, ANNOTATE_MAX } = await import('../../../packages/browser-extension/src/page-annotate')
const { runPageOp } = await import('../../../packages/browser-extension/src/page-ops')

const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return (e as { code?: string }).code } }

describe('annotate', () => {
  it('before any annotated screenshot a label names nothing', () => {
    expect(code(() => refOfLabel(1))).toBe('no_labels')
  })

  const scene = () => {
    page.load('<button id="one">Next</button><a id="two" href="/help">Help</a><button id="hid" style="visibility: hidden">Gone</button>'
      + '<button id="under">Under</button><button id="off">Off</button><input id="nobox"><div id="cover">Cookies</div>', { pageHeight: 3000 })
    page.place('#one', { x: 100, y: 100, w: 80, h: 30 })
    page.place('#two', { x: 300, y: 50, w: 80, h: 20 })
    page.place('#hid', { x: 500, y: 50, w: 80, h: 20 })
    page.place('#under', { x: 100, y: 300, w: 80, h: 30 })
    page.place('#off', { x: 100, y: 2000, w: 80, h: 30 })
    page.place('#cover', { x: 0, y: 280, w: 1000, h: 80 }, { fixed: true })
  }

  beforeEach(scene)

  it('numbers what is on screen and uncovered, top to bottom, with its ref and box', () => {
    const r = annotate()
    expect(r.vw).toBe(1000)
    expect(r.vh).toBe(800)
    expect(r.boxes.map((b) => b.name)).toEqual(['Help', 'Next'])
    expect(r.boxes[0]).toMatchObject({ label: 1, role: 'link', x: 300, y: 50, w: 80, h: 20, ref: pa.refFor(page.$('#two')) })
    expect(r.boxes[1]).toMatchObject({ label: 2, role: 'button', ref: pa.refFor(page.$('#one')) })
    expect(r.more).toBeUndefined()
  })

  it('a label is its element: clicked through the page op, stale once the element is gone', async () => {
    annotate()
    expect(refOfLabel(2)).toBe(pa.refFor(page.$('#one')))
    expect(code(() => refOfLabel(9))).toBe('stale_ref')
    const r = await runPageOp('click', { label: 2 }) as Record<string, unknown>
    expect(r.clicked).toBe('button "Next"')
    page.$('#two').remove()
    expect(code(() => refOfLabel(1))).toBe('stale_ref')
  })

  it(`at most ${150}: the rest is counted`, () => {
    const n = ANNOTATE_MAX + 10
    page.load(Array.from({ length: n }, (_, i) => `<button id="b${i}">Item ${i}</button>`).join(''))
    for (let i = 0; i < n; i++) page.place(`#b${i}`, { x: (i % 10) * 90, y: Math.floor(i / 10) * 40, w: 80, h: 30 })
    const r = annotate()
    expect(r.boxes).toHaveLength(ANNOTATE_MAX)
    expect(r.more).toBe(10)
    expect(r.boxes[0].name).toBe('Item 0')
    expect(r.boxes[1].name).toBe('Item 1')
    expect(r.boxes[10].name).toBe('Item 10')
  })
})

describe('the picture: numbers drawn, a zoom cropped', () => {
  const g = globalThis as any
  const canvases: Array<{ width: number; height: number; log: unknown[][]; type?: string; quality?: number }> = []
  let closed = 0
  const ctx = (log: unknown[][]) => new Proxy({}, {
    get: (_t, k) => (...a: unknown[]) => { log.push([String(k), ...a]) },
    set: (_t, k, v) => { log.push([`set ${String(k)}`, v]); return true },
  })
  g.OffscreenCanvas = class {
    log: unknown[][] = []
    type?: string
    quality?: number
    constructor(public width: number, public height: number) { canvases.push(this) }
    getContext() { return ctx(this.log) }
    async convertToBlob(o: { type: string; quality?: number }) { this.type = o.type; this.quality = o.quality; return { arrayBuffer: async () => new TextEncoder().encode('PIXELS').buffer } }
  }
  const bmp = { width: 2000, height: 1600, close: () => { closed++ } }
  g.createImageBitmap = async () => bmp
  g.fetch = async () => ({ blob: async () => ({}) })
  const shot = 'data:image/png;base64,AAAA'

  beforeEach(() => { canvases.length = 0; closed = 0 })

  it('each box outlined and its number on a tag at its corner, at the picture\'s own pixels', async () => {
    const { drawLabels } = await import('../../../packages/browser-extension/src/agent-picture')
    const out = await drawLabels(shot, [{ label: 7, ref: 'e1', role: 'button', name: 'Go', x: 10, y: 20, w: 50, h: 30 }], 1000, true)
    expect(out).toBe('data:image/png;base64,UElYRUxT')
    const c = canvases[0]
    expect([c.width, c.height]).toEqual([2000, 1600])
    expect(c.log[0]).toEqual(['drawImage', bmp, 0, 0])
    expect(c.log).toContainEqual(['strokeRect', 20, 40, 100, 60])
    expect(c.log).toContainEqual(['fillRect', 20, 12, 30, 28])
    expect(c.log).toContainEqual(['fillText', '7', 28, 26])
    expect(c.log).toContainEqual(['set font', 'bold 22px sans-serif'])
    expect(closed).toBe(1)
  })

  it('a JPEG picture stays JPEG', async () => {
    const { drawLabels } = await import('../../../packages/browser-extension/src/agent-picture')
    const out = await drawLabels(shot, [], 1000, false)
    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(canvases[0]).toMatchObject({ type: 'image/jpeg', quality: 0.8 })
  })

  it('a zoom is the region at full resolution; nothing of it on screen is null', async () => {
    const { cropPicture } = await import('../../../packages/browser-extension/src/agent-picture')
    const r = await cropPicture(shot, { x: 100, y: 50, width: 200, height: 100 }, 1000, true)
    expect(r).toEqual({ image: 'data:image/png;base64,UElYRUxT', width: 400, height: 200, scale: 2 })
    expect([canvases[0].width, canvases[0].height]).toEqual([400, 200])
    expect(canvases[0].log[0]).toEqual(['drawImage', bmp, 200, 100, 400, 200, 0, 0, 400, 200])
    expect(await cropPicture(shot, { x: 1200, y: 0, width: 100, height: 100 }, 1000, true)).toBeNull()
    expect(closed).toBe(2)
  })
})
