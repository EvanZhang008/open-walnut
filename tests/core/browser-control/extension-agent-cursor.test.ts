/**
 * The agent's cursor in the page (packages/browser-extension/src/page-cursor.ts), run for real
 * against a small DOM (page-dom-fake.ts) through the page's own step code (page-ops.ts):
 *   - a ratchet: every action an agent can call (the action sets and switch cases of agent.ts,
 *     agent-page.ts, page-ops.ts and agent-trusted.ts) either moves the cursor (cursor-acts.ts
 *     CURSOR_ACTS) or says why not (NO_CURSOR), and each page step listed there really draws it at
 *     its target; each real-input step asks the page to draw it before the debugger acts;
 *   - the cursor never takes a click (pointer-events none on the host and inside), sits above all
 *     at the highest z-index, has no size (no layout), and moving it scrolls and focuses nothing;
 *   - it moves in an animated step, a first appearance shows before the step acts, a click shows
 *     its animation; with prefers-reduced-motion it jumps and waits for nothing;
 *   - each look (cursor-looks.ts) draws with no pointer events, is masked in screenshots and plays
 *     its click; the person's pick is read from storage.local (`settings.cursorStyle`), a bad or
 *     missing one is the default, and a change redraws a cursor on show in place;
 *   - an agent's screenshot hides it (with the secrets mask), and it is back after;
 *   - from a frame it is drawn in the top document when the background places it, else in the
 *     frame's own document; a frame's place is read with runtime.getFrameId.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakePage } from './page-dom-fake'

const frameIds = new Map<Element, number>()
const sent: Array<Record<string, unknown>> = []
let upAnswer: Record<string, unknown> | undefined = { ok: true, placed: true }
/** What storage.local holds; `null`: a storage that never answers; a number: one that answers after that many ms. */
let stored: Record<string, unknown> | null = {}
let storeDelay = 0
;(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (k: string) => {
        if (stored === null) return new Promise(() => undefined)
        const now = stored
        if (storeDelay) await new Promise((r) => setTimeout(r, storeDelay))
        return { [k]: now[k] }
      },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  runtime: {
    id: 'test',
    getFrameId: (el: Element) => frameIds.get(el) ?? -1,
    sendMessage: async (m: Record<string, unknown>) => { sent.push(m); return upAnswer },
    onMessage: { addListener() {}, removeListener() {} },
  },
}
const page = installFakePage()
const pa = await import('../../../packages/browser-extension/src/page-agent')
const { runPageOp } = await import('../../../packages/browser-extension/src/page-ops')
const cur = await import('../../../packages/browser-extension/src/page-cursor')
const { CURSOR_ACTS, NO_CURSOR } = await import('../../../packages/browser-extension/src/cursor-acts')
const { PAGE_OPS } = await import('../../../packages/browser-extension/src/agent-page')
const { TRUSTED_OPS, DEBUGGER_OPS } = await import('../../../packages/browser-extension/src/agent-trusted')
const { NET_OPS } = await import('../../../packages/browser-extension/src/agent-net')
const looks = await import('../../../packages/browser-extension/src/cursor-looks')

const SRC = 'packages/browser-extension/src'
const read = (f: string) => readFileSync(`${SRC}/${f}`, 'utf8')
const ref = (sel: string) => pa.refFor(page.$(sel))
const at = () => { const c = cur._cursorForTesting(); return c ? { x: c.x, y: c.y } : null }
const g = globalThis as any

beforeEach(() => {
  cur._resetCursorForTesting()
  delete g.matchMedia
  delete g.top
  sent.length = 0
  upAnswer = { ok: true, placed: true }
  stored = {}
  storeDelay = 0
  frameIds.clear()
  page.load('')
})

/** The cases of a `switch` in one function of a file. */
function casesIn(file: string, from: string, to?: string): string[] {
  const s = read(file)
  const i = s.indexOf(from)
  expect(i, `${from} in ${file}`).toBeGreaterThan(-1)
  const end = to ? s.indexOf(to, i + from.length) : s.length
  return [...s.slice(i, end).matchAll(/case '([a-z_]+)'/g)].map((m) => m[1])
}

describe('every action either moves the cursor or says why not (ratchet)', () => {
  it('the action sets and switch cases of agent.ts, agent-page.ts, page-ops.ts and agent-trusted.ts are all listed once', () => {
    const offScreen = /OFF_SCREEN_ACTS = new Set\(\[([^\]]+)\]\)/.exec(read('agent.ts'))![1]
    const all = new Set<string>([
      ...PAGE_OPS, ...TRUSTED_OPS, ...DEBUGGER_OPS, ...NET_OPS,
      ...[...offScreen.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
      ...casesIn('agent.ts', 'async function act(', '\n}\n'),
      ...casesIn('page-ops.ts', 'export async function runPageOp('),
      ...casesIn('agent-trusted.ts', 'export async function trustedAct('),
    ])
    expect(all.size).toBeGreaterThan(30)
    for (const a of all) {
      const listed = (a in CURSOR_ACTS ? 1 : 0) + (a in NO_CURSOR ? 1 : 0)
      expect(listed, `${a}: add it to CURSOR_ACTS (it points at something) or NO_CURSOR (with why) in cursor-acts.ts`).toBe(1)
    }
  })

  it('each real-input step that points asks the page for the cursor before the debugger acts (agent-trusted.ts)', () => {
    const s = read('agent-trusted.ts')
    for (const op of TRUSTED_OPS) {
      if (!(op in CURSOR_ACTS)) continue
      const i = s.indexOf(`case '${op}':`)
      const block = s.slice(i, s.indexOf('break', i))
      expect(block, `${op} in agent-trusted.ts`).toMatch(/cursor: '(click|move)'/)
    }
    // A drag: the page puts it at the start, and it goes along to the end as the debugger drags.
    expect(read('agent-drag.ts')).toMatch(/type: 'agent-cursor'[^\n]*kind: 'drag'/)
  })

  const steps: Array<[string, () => Record<string, unknown>, { x: number; y: number }]> = [
    ['click', () => ({ ref: ref('#buy') }), { x: 150, y: 120 }],
    ['click', () => ({ x: 40, y: 310 }), { x: 40, y: 310 }],
    ['hover', () => ({ ref: ref('#buy') }), { x: 150, y: 120 }],
    ['type', () => ({ ref: ref('#q'), text: 'paper' }), { x: 300, y: 215 }],
    ['type', () => ({ x: 310, y: 212, text: 'paper' }), { x: 310, y: 212 }],
    // linkedom's select has a read-only value: a plain one stands in.
    ['select', () => { Object.defineProperty(page.$('#size'), 'value', { configurable: true, writable: true, value: '' }); return { ref: ref('#size'), value: 'a4' } }, { x: 550, y: 415 }],
    ['scroll', () => ({ ref: ref('#list'), direction: 'down' }), { x: 750, y: 400 }],
    ['scroll', () => ({ x: 760, y: 380, direction: 'down' }), { x: 760, y: 380 }],
    ['drag_points', () => ({ ref: ref('#card'), to_ref: ref('#list') }), { x: 140, y: 620 }],
    ['locate', () => ({ ref: ref('#buy'), cursor: 'click' }), { x: 150, y: 120 }],
  ]
  const shop = () => {
    page.load(`<button id="buy">Add to cart</button><div id="spot">Spot</div><input id="q"><select id="size"><option value="a4">A4</option></select>
      <div id="list" style="overflow-y: auto">${'<p>row</p>'.repeat(3)}</div><div id="card" tabindex="0">Card</div>`)
    page.place('#buy', { x: 100, y: 100, w: 100, h: 40 })
    page.place('#spot', { x: 0, y: 300, w: 100, h: 30 })
    page.place('#q', { x: 200, y: 200, w: 200, h: 30 })
    page.place('#size', { x: 500, y: 400, w: 100, h: 30 })
    page.place('#list', { x: 700, y: 300, w: 100, h: 200 })
    page.scrollable('#list', { content: 900, height: 200 })
    page.place('#card', { x: 100, y: 600, w: 80, h: 40 })
  }

  it.each(steps)('%s draws the cursor at its target before it acts', async (op, args, want) => {
    shop()
    // The cursor is at the target when the step acts: the page sees it there before its own events.
    let seenAt: { x: number; y: number } | null = null
    for (const t of ['pointerdown', 'mouseover', 'input', 'change', 'pointerover']) page.$('body').ownerDocument.addEventListener(t, () => { seenAt ??= at() }, { once: true })
    await runPageOp(op, args())
    expect(at()).toEqual(want)
    if (seenAt) expect(seenAt).toEqual(want)
    expect(op in CURSOR_ACTS).toBe(true)
  })

  it('upload: at the file field when it is on screen, nowhere when the page hides it', async () => {
    page.load('<input id="f" type="file"><input id="hidden" type="file">')
    page.place('#f', { x: 10, y: 10, w: 100, h: 20 })
    ;(globalThis as any).DataTransfer = class { items = { add() {} }; files = [] as unknown[] }
    ;(globalThis as any).File = class { constructor(public _b: unknown, public name: string) {} size = 1 }
    await runPageOp('upload', { ref: ref('#f'), files: [{ name: 'a.txt', base64: 'YQ==' }] }).catch(() => undefined)
    expect(at()).toEqual({ x: 60, y: 20 })
    cur._resetCursorForTesting()
    await runPageOp('upload', { ref: ref('#hidden'), files: [{ name: 'a.txt', base64: 'YQ==' }] }).catch(() => undefined)
    expect(at()).toBeNull()
  })

  it('steps with no point draw nothing: a key, a read, a scroll of the whole page, a locate for keys', async () => {
    page.load('<button id="buy">Add to cart</button><input id="q">', { pageHeight: 3000 })
    page.place('#buy', { x: 100, y: 100, w: 100, h: 40 })
    page.place('#q', { x: 200, y: 200, w: 200, h: 30 })
    ;(page.$('#q') as HTMLElement).focus()
    await runPageOp('press', { key: 'a' })
    await runPageOp('snapshot', {})
    await runPageOp('scroll', { direction: 'down' })
    await runPageOp('locate', { active: true })
    await runPageOp('locate', { ref: ref('#buy') })
    expect(at()).toBeNull()
  })

  it('a click held for the person\'s yes points at what it waits on, with no ripple', async () => {
    page.load('<button id="pay">Pay now</button>')
    page.place('#pay', { x: 100, y: 100, w: 100, h: 40 })
    const r = await runPageOp('click', { ref: ref('#pay') }) as Record<string, unknown>
    expect(r.hold).toBeDefined()
    expect(at()).toEqual({ x: 150, y: 120 })
    expect(cur._cursorForTesting()!.rippling).toBe(false)
  })
})

describe('the background answers what the page sends', () => {
  it('every message a content script sends (ask) is one background.ts takes from a page (ALLOWED ... content)', () => {
    const bg = read('background.ts')
    // A key named by a constant ([BROWSER_KEY_MESSAGE]) is read as the constant's text.
    const consts = new Map(readdirSync(SRC).flatMap((f) => [...read(f).matchAll(/export const ([A-Z_]+) = '([a-z-]+)'/g)].map((m) => [m[1], m[2]] as const)))
    const allowed = bg.slice(bg.indexOf('const ALLOWED'), bg.indexOf('\n}\n', bg.indexOf('const ALLOWED'))).replace(/\[([A-Z_]+)\]:/g, (_m, k: string) => `'${consts.get(k) ?? k}':`)
    const files = readdirSync(SRC).filter((f) => /^(content|page-)[\w-]*\.ts$/.test(f))
    const types = new Set(files.flatMap((f) => [...read(f).matchAll(/ask(?:<[^>]*>)?\(\{ type: '([a-z-]+)'/g)].map((m) => m[1])))
    expect(types.has('agent-cursor-up')).toBe(true)
    for (const t of types) expect(allowed, `${t}: add it to ALLOWED in background.ts as 'content'`).toMatch(new RegExp(`'${t}': (\\[[^\\]]*)?'content'`))
  })
})

describe('the cursor never gets in the way', () => {
  it('takes no pointer events, sits above everything, has no size, and moves neither scroll nor focus', async () => {
    page.load('<button id="a">A</button><input id="q">')
    page.place('#a', { x: 100, y: 100, w: 100, h: 40 })
    ;(page.$('#q') as HTMLElement).focus()
    const before = { x: page.scroll.x, y: page.scroll.y, focus: document.activeElement, intoView: page.intoView }
    await cur.cursorAt(300, 200, 'click')
    const host = cur._cursorForTesting()!.host
    expect(host.tagName).toBe('WALNUT-EXT')
    const css = host.style.cssText
    // The last pointer-events wins in the style attribute: none.
    expect([...css.matchAll(/pointer-events:\s*(\w+)/g)].at(-1)![1]).toBe('none')
    expect(css).toMatch(/z-index:\s*2147483647/)
    expect(css).toMatch(/width:\s*0/)
    expect(css).toMatch(/height:\s*0/)
    expect(css).toMatch(/position:\s*fixed/)
    expect(host.isConnected).toBe(true)
    expect({ x: page.scroll.x, y: page.scroll.y, focus: document.activeElement, intoView: page.intoView }).toEqual(before)
    // Nothing a click looks for is ever the cursor.
    expect(document.elementFromPoint(300, 200)).not.toBe(host)
    // Every rule inside it takes no pointer events either, in every look (the shadow root is closed: its style text is read from the looks).
    for (const style of looks.CURSOR_STYLES) {
      const css = looks.cursorCss(style)
      expect(css.startsWith('.c,.c *{pointer-events:none !important}'), style).toBe(true)
      for (const rule of css.match(/^\.c[^{]*\{[^}]*\}/gm) ?? []) {
        if (/position:absolute|position:fixed/.test(rule)) expect(rule, rule).toMatch(/pointer-events:none/)
      }
    }
  })

  it('cursorOff takes it out of the page; the next step draws it again', async () => {
    await cur.cursorAt(10, 10)
    const host = cur._cursorForTesting()!.host
    cur.cursorOff()
    expect(host.isConnected).toBe(false)
    expect(cur._cursorForTesting()).toBeNull()
    await cur.cursorAt(20, 20)
    expect(at()).toEqual({ x: 20, y: 20 })
  })

  it('a page that removes it gets a new one at the next step', async () => {
    await cur.cursorAt(10, 10)
    cur._cursorForTesting()!.host.remove()
    await cur.cursorAt(30, 40)
    expect(at()).toEqual({ x: 30, y: 40 })
  })

  it('hidden while the agent\'s own screenshot is taken, back after; one drawn meanwhile is hidden too', async () => {
    await cur.cursorAt(10, 10)
    cur.cursorMask(true)
    expect(cur._cursorForTesting()!.hidden).toBe(true)
    cur.cursorOff()
    await cur.cursorAt(10, 10)
    expect(cur._cursorForTesting()!.hidden).toBe(true)
    cur.cursorMask(false)
    expect(cur._cursorForTesting()!.hidden).toBe(false)
  })

  it('content.ts hides it with the screenshot mask, takes it away when the person takes the tab over or presses Stop, and listens for the background', () => {
    const s = read('content.ts')
    expect(s).toMatch(/case 'agent-mask':[\s\S]{0,300}cursorMask\(msg\.on === true\)/)
    expect(s).toMatch(/if \(mode === 'driving'\) cursorOff\(\)/)
    expect(s).toMatch(/type: 'agent-stop' \}\)\.then\(\(\) => \{ cursorOff\(\)/)
    expect(s).toMatch(/\nlistenCursor\(\)\n/)
  })
})

describe('motion', () => {
  const motion = (reduce: boolean) => { g.matchMedia = (q: string) => ({ matches: reduce && q.includes('reduce') }) }

  it('a first appearance shows before the step acts; a move takes its time; a click ripples on arrival', async () => {
    motion(false)
    let t = Date.now()
    await cur.cursorAt(100, 100, 'move')
    expect(Date.now() - t).toBeGreaterThanOrEqual(cur.FIRST_MS - 15)
    t = Date.now()
    await cur.cursorAt(400, 500, 'click')
    const took = Date.now() - t
    expect(took).toBeGreaterThanOrEqual(cur.MOVE_MIN_MS - 15)
    expect(took).toBeLessThan(cur.MOVE_MAX_MS + 250)
    expect(cur._cursorForTesting()!.rippling).toBe(true)
    await new Promise((r) => setTimeout(r, cur.RIPPLE_MS + 30))
    expect(cur._cursorForTesting()!.rippling).toBe(false)
  })

  it('with prefers-reduced-motion it jumps there and waits for nothing, and is still shown', async () => {
    motion(true)
    const t = Date.now()
    await cur.cursorAt(100, 100)
    await cur.cursorAt(900, 700, 'click')
    expect(Date.now() - t).toBeLessThan(60)
    expect(at()).toEqual({ x: 900, y: 700 })
    for (const style of looks.CURSOR_STYLES) expect(looks.cursorCss(style), style).toMatch(/@media \(prefers-reduced-motion: reduce\)\{\.c\{transition:none\}[^\n]*\.c \*,\.c\.on \*\{animation:none !important\}/)
  })
})

describe('a page nobody sees (a covered agent window)', () => {
  it('the cursor goes there with no move to wait for: the browser would slow the timers to a second', async () => {
    g.matchMedia = () => ({ matches: false })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      const t = Date.now()
      await cur.cursorAt(100, 100)
      await cur.cursorAt(900, 700, 'click')
      expect(Date.now() - t).toBeLessThan(60)
      expect(at()).toEqual({ x: 900, y: 700 })
    } finally {
      delete (document as any).visibilityState
    }
  })
})

describe('in a frame', () => {
  it('from a frame: the point goes to the background, which draws it in the top document; nothing here', async () => {
    g.top = {}
    await cur.pointAt(15, 25, 'click')
    expect(sent).toEqual([{ type: 'agent-cursor-up', x: 15, y: 25, kind: 'click' }])
    expect(at()).toBeNull()
  })

  it('when the background cannot place it, the frame draws it in its own document', async () => {
    g.top = {}
    upAnswer = { ok: true, placed: false }
    await cur.pointAt(15, 25)
    expect(at()).toEqual({ x: 15, y: 25 })
  })

  it('a frame\'s place in the top document is read from its element, inside its border and padding', () => {
    page.load('<iframe id="f" style="padding-left: 4px; padding-top: 6px"></iframe><iframe id="g"></iframe>')
    page.place('#f', { x: 100, y: 200, w: 300, h: 200 })
    page.place('#g', { x: 500, y: 50, w: 300, h: 200 })
    frameIds.set(page.$('#f'), 5)
    frameIds.set(page.$('#g'), 9)
    g.getComputedStyle = ((orig) => (el: Element) => ({ ...orig(el), paddingLeft: el.id === 'f' ? '4px' : '0px', paddingTop: el.id === 'f' ? '6px' : '0px' }))(g.getComputedStyle)
    expect(cur.frameBox(5)).toEqual({ x: 104, y: 206 })
    expect(cur.frameBox(9)).toEqual({ x: 500, y: 50 })
    // Not one of this document's frames, and the top frame itself: no place here.
    expect(cur.frameBox(42)).toBeNull()
    expect(cur.frameBox(0)).toBeNull()
  })
})

describe('the looks', () => {
  it('each look draws with no pointer events, its tag, no size of its own, hidden in screenshots, and plays its click', async () => {
    page.load('<button id="a">A</button>')
    page.place('#a', { x: 100, y: 100, w: 100, h: 40 })
    expect(looks.CURSOR_STYLES.length).toBe(4)
    for (const style of looks.CURSOR_STYLES) {
      cur._resetCursorForTesting()
      cur.setCursorLook(style)
      await cur.cursorAt(150, 120, 'click')
      const c = cur._cursorForTesting()!
      expect(c.look, style).toBe(style)
      expect(c.box.dataset.look).toBe(style)
      expect([...c.host.style.cssText.matchAll(/pointer-events:\s*(\w+)/g)].at(-1)![1]).toBe('none')
      expect(c.host.style.cssText).toMatch(/width:\s*0/)
      expect(document.elementFromPoint(150, 120)).toBe(page.$('#a'))
      expect(c.box.querySelector('.tag')!.textContent).toBe('Walnut')
      expect(c.box.querySelector('svg'), style).not.toBeNull()
      expect(c.rippling, style).toBe(true)
      cur.cursorMask(true)
      expect(cur._cursorForTesting()!.hidden, style).toBe(true)
      expect(looks.cursorCss(style)).toMatch(/\.c\.hid\{visibility:hidden\}/)
      cur.cursorMask(false)
      expect(cur._cursorForTesting()!.hidden, style).toBe(false)
    }
  })

  it('the person\'s pick is read from storage.local before the first drawing; a bad or missing one, or a storage that does not answer, is the default', async () => {
    stored = { settings: { cursorStyle: 'paw' } }
    await cur.cursorAt(10, 10)
    expect(cur._cursorForTesting()!.look).toBe('paw')
    for (const [value, want] of [[{ settings: { cursorStyle: 'laser' } }, looks.DEFAULT_CURSOR_STYLE], [{}, looks.DEFAULT_CURSOR_STYLE]] as const) {
      cur._resetCursorForTesting()
      stored = value as Record<string, unknown>
      await cur.cursorAt(10, 10)
      expect(cur._cursorForTesting()!.look).toBe(want)
    }
    cur._resetCursorForTesting()
    stored = null
    const t = Date.now()
    await cur.cursorAt(10, 10)
    expect(Date.now() - t).toBeLessThan(1000)
    expect(cur._cursorForTesting()!.look).toBe(looks.DEFAULT_CURSOR_STYLE)
  })

  it('the shipped look is the Walnut badge; a stored Walnut buddy counts only when the person picked it', async () => {
    expect(looks.DEFAULT_CURSOR_STYLE).toBe('badge')
    for (const [settings, want] of [
      [{ cursorStyle: 'nut' }, 'badge'],
      [{ cursorStyle: 'nut', cursorStyleChosen: true }, 'nut'],
      [{ cursorStyle: 'arrow' }, 'arrow'],
      [{ cursorStyle: 'laser', cursorStyleChosen: true }, 'badge'],
      [undefined, 'badge'],
    ] as const) {
      expect(looks.storedCursorStyle(settings), JSON.stringify(settings)).toBe(want)
      cur._resetCursorForTesting()
      stored = settings ? { settings } : {}
      await cur.cursorAt(10, 10)
      expect(cur._cursorForTesting()!.look, JSON.stringify(settings)).toBe(want)
    }
    expect(read('popup-cursor-pick.ts')).toMatch(/setSettings\(\{ cursorStyle: select\.value, cursorStyleChosen: true \}\)/)
  })

  it('a pick changed while it is on show draws it again in place, still masked if it was; content listens for the change', async () => {
    await cur.cursorAt(40, 60)
    const before = cur._cursorForTesting()!.host
    cur.cursorMask(true)
    const other = looks.CURSOR_STYLES.find((s) => s !== looks.DEFAULT_CURSOR_STYLE)!
    cur.setCursorLook(other)
    const now = cur._cursorForTesting()!
    expect(before.isConnected).toBe(false)
    expect(now.look).toBe(other)
    expect({ x: now.x, y: now.y }).toEqual({ x: 40, y: 60 })
    expect(now.hidden).toBe(true)
    expect(now.box.style.transform).toBe('translate(40px, 60px)')
    expect(read('page-cursor.ts')).toMatch(/onChanged\?\.addListener\(\(changes, area\) => \{\s*if \(area === 'local' && 'settings' in changes\) setCursorLook\(/)
  })

  it('let go while the look is still being read: nothing is drawn after it', async () => {
    stored = { settings: { cursorStyle: 'paw' } }
    storeDelay = 80
    const drawing = cur.cursorAt(10, 10)
    cur.cursorOff()
    await drawing
    expect(cur._cursorForTesting()).toBeNull()
  })

  it('a change that comes while the first read is on its way wins over the older read', async () => {
    stored = { settings: { cursorStyle: 'paw' } }
    storeDelay = 80
    const drawing = cur.cursorAt(10, 10)
    cur.setCursorLook('arrow')
    await drawing
    expect(cur._cursorForTesting()!.look).toBe('arrow')
  })

  it('a storage slower than the wait: drawn in the default first, then in the pick, in place', async () => {
    stored = { settings: { cursorStyle: 'paw' } }
    storeDelay = 400
    await cur.cursorAt(25, 35)
    expect(cur._cursorForTesting()!.look).toBe(looks.DEFAULT_CURSOR_STYLE)
    await vi.waitFor(() => expect(cur._cursorForTesting()!.look).toBe('paw'), { timeout: 3000, interval: 20 })
    const c = cur._cursorForTesting()!
    expect({ x: c.x, y: c.y }).toEqual({ x: 25, y: 35 })
  })

  it('every look places its picture from its tip, is hidden from screen readers, and gives each gradient copy its own id', () => {
    for (const style of looks.CURSOR_STYLES) {
      expect(looks.cursorCss(style), style).toMatch(/\.c \.b\{left:-\d+(\.\d+)?px;top:-\d+(\.\d+)?px;transform-origin:\d+(\.\d+)?px \d+(\.\d+)?px\}/)
      const { box } = looks.cursorParts(document, style)
      expect(box.getAttribute('aria-hidden')).toBe('true')
      const ids = [...box.querySelectorAll('[id]')].map((e) => e.id)
      expect(new Set(ids).size, `${style}: ${ids}`).toBe(ids.length)
    }
  })

  it('the shipped look is one constant, it is the settings default, and the popup offers every look', () => {
    expect(looks.isCursorStyle(looks.DEFAULT_CURSOR_STYLE)).toBe(true)
    expect(read('settings.ts')).toMatch(/cursorStyle: DEFAULT_CURSOR_STYLE/)
    expect(read('popup-settings.ts')).toMatch(/cursorPickRow\(settings\.cursorStyle\)/)
    expect(read('popup-cursor-pick.ts')).toMatch(/CURSOR_STYLES\.map/)
    for (const s of looks.CURSOR_STYLES) expect(looks.CURSOR_STYLE_LABELS[s]).toBeTruthy()
  })

  it('nothing in a look can be refused by a page CSP: no inline handler, no style attribute, no external asset', () => {
    const src = read('cursor-looks.ts')
    expect(src).not.toMatch(/\bon[a-z]+=|setAttribute\('style'|style: '|url\((?!#)|https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
    expect(src).not.toMatch(/innerHTML/)
  })
})
