/**
 * A step that buys, sends or deletes waits for the person's yes (page-ops.ts `held`). Each step
 * that acts at a point first moves the agent's cursor there, which takes time (120 to 300 ms, up to
 * seconds from a frame), and the page may change meanwhile. Review 2026-11-09: the step was judged
 * BEFORE the cursor moved and acted after it, on whatever the page put there by then, so a "Place
 * order" that replaced "Add to cart" during the move was clicked with nobody's yes.
 *
 * The rule pinned here, run for real against the small DOM (page-dom-fake.ts): the element is
 * found again and judged after the cursor arrived, and acted on with nothing awaited between (in
 * the page's own click, type, drag and in `locate`, the real-input step right before the
 * debugger presses). A swap during the move is held, and nothing unjudged is clicked or typed in.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { installFakePage } from './page-dom-fake'

;(globalThis as any).chrome = {
  runtime: {
    id: 'test',
    getFrameId: () => -1,
    sendMessage: async () => ({ ok: true, placed: true }),
    onMessage: { addListener() {}, removeListener() {} },
  },
}
const page = installFakePage()
const pa = await import('../../../packages/browser-extension/src/page-agent')
const { runPageOp } = await import('../../../packages/browser-extension/src/page-ops')
const cur = await import('../../../packages/browser-extension/src/page-cursor')
const g = globalThis as any

/** "Add to cart" at (100,100)-(200,140): nothing outward. */
function shop(): void {
  page.load('<button id="cart">Add to cart</button><input id="q"><div id="drop">Drop here</div>')
  page.place('#cart', { x: 100, y: 100, w: 100, h: 40 })
  page.place('#q', { x: 300, y: 100, w: 200, h: 30 })
  page.place('#drop', { x: 100, y: 400, w: 200, h: 100 })
}

/** Every event the page's elements see, per element id. */
function seen(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const t of ['pointerdown', 'mousedown', 'click', 'input', 'keydown']) {
    document.addEventListener(t, (e) => {
      const id = (e.target as Element)?.id || (e.target as Element)?.tagName
      out.set(id, [...(out.get(id) ?? []), t])
    }, true)
  }
  return out
}

/** The page puts "Place order" where "Add to cart" was (a new element over it, the same box). */
function swapToOrder(over: string = '#cart'): void {
  const order = document.createElement('button')
  order.id = 'order'
  order.textContent = 'Place order'
  document.body.append(order)
  const r = page.$(over).getBoundingClientRect()
  page.place(order, { x: r.left, y: r.top, w: r.width, h: r.height })
}

/** The same element renamed (a ref keeps naming it): "Add to cart" becomes "Place order". */
function renameToOrder(): void { page.$('#cart').textContent = 'Place order' }

beforeEach(() => {
  cur._resetCursorForTesting()
  delete g.matchMedia
  shop()
})

const steps: Array<[string, string, () => Record<string, unknown>, () => void]> = [
  ['click at a point, swapped', 'click', () => ({ x: 150, y: 120 }), () => swapToOrder()],
  ['click by ref, renamed', 'click', () => ({ ref: pa.refFor(page.$('#cart')) }), renameToOrder],
  ['type at a point that submits, swapped', 'type', () => ({ x: 150, y: 120, text: 'x' }), () => swapToOrder()],
  ['real-input click at a point (locate), swapped', 'locate', () => ({ x: 150, y: 120, cursor: 'click', outward: 'click' }), () => swapToOrder()],
  ['real-input click by ref (locate), renamed', 'locate', () => ({ ref: pa.refFor(page.$('#cart')), cursor: 'click', outward: 'click' }), renameToOrder],
  ['drag from a point, swapped', 'drag_points', () => ({ x: 150, y: 120, to_x: 200, to_y: 450 }), () => swapToOrder()],
]

describe('the page changes while the cursor moves: what is there when it arrives is judged', () => {
  it.each(steps)('%s: held, nothing clicked', async (_name, op, args, swap) => {
    const events = seen()
    const running = runPageOp(op, args())
    // The step is past its first await (the cursor's move) when this runs.
    swap()
    const r = await running as Record<string, unknown>
    expect(r.hold, JSON.stringify(r)).toMatchObject({ kind: 'buy' })
    expect(String((r.hold as { what: string }).what)).toMatch(/Place order/)
    // Nothing reached the element nobody judged (nor the old one).
    expect(events.get('order') ?? []).toEqual([])
    expect(events.get('cart') ?? []).toEqual([])
    // A real-input step answers no point to press: the debugger presses nothing.
    expect(r.x).toBeUndefined()
  })

  it('with motion on, the swap lands in the middle of the move and is still held', async () => {
    g.matchMedia = () => ({ matches: false })
    const events = seen()
    // The cursor's first appearance waits FIRST_MS: the swap comes well inside it.
    setTimeout(() => swapToOrder(), Math.floor(cur.FIRST_MS / 4))
    const r = await runPageOp('click', { x: 150, y: 120 }) as Record<string, unknown>
    expect(r.hold).toMatchObject({ kind: 'buy' })
    expect(events.get('order') ?? []).toEqual([])
  })

  it('the other way round: a step that looked held but is safe once the cursor arrives goes ahead on what is there', async () => {
    page.$('#cart').textContent = 'Place order'
    const events = seen()
    const running = runPageOp('click', { ref: pa.refFor(page.$('#cart')) })
    page.$('#cart').textContent = 'Add to cart'
    const r = await running as Record<string, unknown>
    expect(r.hold).toBeUndefined()
    expect(events.get('cart')).toEqual(expect.arrayContaining(['pointerdown']))
  })

  it('nothing changes: an ordinary click still clicks, and the cursor is there first', async () => {
    const events = seen()
    const r = await runPageOp('click', { x: 150, y: 120 }) as Record<string, unknown>
    expect(r.clicked).toMatch(/Add to cart/)
    expect(events.get('cart')).toEqual(expect.arrayContaining(['pointerdown']))
    expect(cur._cursorForTesting()).toMatchObject({ x: 150, y: 120 })
  })
})

describe('the source keeps the order (a ratchet)', () => {
  const src = readFileSync('packages/browser-extension/src/page-ops.ts', 'utf8')
  /** The page step code, cut at each function and each case of runPageOp. */
  const chunks = src.split(/\n(?=(?:export )?(?:async )?function |\s+case ')/)

  it('every step judged with held() awaits nothing after it: the judged element is the one acted on', () => {
    const judged = chunks.filter((c) => /\bheld\(args/.test(c) && !/^\s*function held\(/.test(c))
    expect(judged.length).toBeGreaterThanOrEqual(5)
    for (const c of judged) {
      // From the last judging on (a branch that answers at once may judge earlier).
      const after = c.slice(c.lastIndexOf('held(args'))
      expect(after, c.split('\n')[0]).not.toMatch(/\bawait\b/)
    }
  })

  it('the click, type, drag and locate steps move the cursor before they judge', () => {
    for (const [name, c] of [['click', chunks.find((x) => /^\s*case 'click'/.test(x))], ['typeOp', chunks.find((x) => /function typeOp/.test(x))],
      ['drag_points', chunks.find((x) => /^\s*case 'drag_points'/.test(x))], ['locate', chunks.find((x) => /function locate/.test(x))]] as const) {
      expect(c, name).toBeDefined()
      const judge = c!.search(/\bheld\(args, (?!trustedHow\(args\)\.map\(\(how\): Part => \[how, document\.activeElement)/)
      const cursor = c!.search(/await pointAt\(/)
      expect(cursor, `${name}: the cursor moves first`).toBeGreaterThan(-1)
      expect(judge, `${name}: judged after the cursor`).toBeGreaterThan(cursor)
    }
  })
})
