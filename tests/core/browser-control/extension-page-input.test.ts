/**
 * The page side of the newer input, run for real against a small DOM (page-dom-fake.ts): the
 * modules the background asks (packages/browser-extension/src/page-input.ts through page-ops.ts),
 * not a fake of their answers.
 *   - a drag's two ends: both on screen, read again after a scroll (a start given as a point is
 *     refused then, a start given as a ref is checked for cover again), too short or on one button
 *     is a click (`drag_too_short`), and a drag onto a control that deletes, buys or sends waits for
 *     the person's yes, one yes for all of its parts;
 *   - slow typing: a key at a time, a newline is the Enter key and is judged as a submit, and it
 *     stops before its next key once the background cancels it (a dialog cut the step short);
 *   - typing at a point: the click there and the Enter are one ask with one yes;
 *   - a scroll that names an element scrolls the box it is in.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { installFakePage, recordEvents } from './page-dom-fake'

const page = installFakePage()
const pa = await import('../../../packages/browser-extension/src/page-agent')
const { runPageOp } = await import('../../../packages/browser-extension/src/page-ops')
const { cancelTyping, typeSlowly } = await import('../../../packages/browser-extension/src/page-input')

const ref = (sel: string) => pa.refFor(page.$(sel))
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)
type R = Record<string, any>

beforeEach(() => page.load(''))

describe('drag: the two ends', () => {
  const cards = (opts: { pageHeight?: number } = {}) => {
    page.load('<div id="a" tabindex="0">Card A</div><div id="b" role="list">Done</div><button id="del">Delete</button><a id="send" href="#" role="button">Send</a><button id="wide">Move</button><iframe id="f"></iframe>', opts)
    page.place('#a', { x: 100, y: 100, w: 100, h: 40 })
    page.place('#b', { x: 400, y: 300, w: 200, h: 100 })
    page.place('#del', { x: 700, y: 100, w: 80, h: 30 })
    page.place('#send', { x: 700, y: 200, w: 80, h: 30 })
    page.place('#wide', { x: 100, y: 500, w: 300, h: 40 })
    page.place('#f', { x: 600, y: 500, w: 300, h: 200 })
  }

  it('from a ref to a ref: the middle of each, named', async () => {
    cards()
    const r = await runPageOp('drag_points', { ref: ref('#a'), to_ref: ref('#b') }) as R
    expect(r.from).toMatchObject({ x: 150, y: 120 })
    expect(r.from.what).toContain('Card A')
    expect(r.to).toMatchObject({ x: 500, y: 350 })
    expect(r.to.what).toContain('Done')
    expect(r.hold).toBeUndefined()
  })

  it('too short to be anything but a click, or on one button: drag_too_short', async () => {
    cards()
    expect(await code(runPageOp('drag_points', { x: 150, y: 120, to_x: 153, to_y: 122 }))).toBe('drag_too_short')
    expect(await code(runPageOp('drag_points', { x: 110, y: 520, to_x: 380, to_y: 520 }))).toBe('drag_too_short')
  })

  it('an end inside a frame is refused (real input is top frame only)', async () => {
    cards()
    expect(await code(runPageOp('drag_points', { ref: ref('#a'), to_x: 700, to_y: 600 }))).toBe('trusted_frame')
  })

  it('a drag onto a control that deletes waits for the person; the yes for that step lets it go', async () => {
    cards()
    const r = await runPageOp('drag_points', { ref: ref('#a'), to_ref: ref('#del') }) as R
    expect(r.hold).toMatchObject({ kind: 'delete' })
    expect(r.hold.what).toContain('Delete')
    expect(r.from).toBeUndefined()
    const ok = await runPageOp('drag_points', { ref: ref('#a'), to_ref: ref('#del'), outward_ok: r.hold.sig }) as R
    expect(ok.hold).toBeUndefined()
    expect(ok.to.what).toContain('Delete')
  })

  it('a drag whose start and end both act is one ask: one yes covers both, the yes for one part does not', async () => {
    cards()
    const args = { ref: ref('#send'), to_ref: ref('#del') }
    const r = await runPageOp('drag_points', args) as R
    // The gravest kind leads; both parts are named, and the signature covers both.
    expect(r.hold.kind).toBe('delete')
    expect(r.hold.what).toMatch(/Send.*then.*Delete/)
    expect(r.hold.sig).toContain('&')
    const part = String(r.hold.sig).split('&')[1]
    expect((await runPageOp('drag_points', { ...args, outward_ok: part }) as R).hold).toBeDefined()
    expect((await runPageOp('drag_points', { ...args, outward_ok: r.hold.sig }) as R).hold).toBeUndefined()
  })

  it('a start given as a point is refused when bringing the end into view scrolled the page', async () => {
    cards({ pageHeight: 3000 })
    page.place('#b', { x: 400, y: 1500, w: 200, h: 100 })
    expect(await code(runPageOp('drag_points', { x: 150, y: 120, to_ref: ref('#b') }))).toBe('drag_offscreen')
    expect(page.scroll.y).toBeGreaterThan(0)
  })

  it('a start given as a ref is read again after that scroll', async () => {
    cards({ pageHeight: 3000 })
    page.place('#b', { x: 400, y: 850, w: 200, h: 40 })
    const r = await runPageOp('drag_points', { ref: ref('#a'), to_ref: ref('#b') }) as R
    expect(page.scroll.y).toBe(90)
    expect(r.from).toMatchObject({ x: 150, y: 30 })
    expect(r.to).toMatchObject({ x: 500, y: 780 })
  })

  it('...and checked for cover again: a fixed banner over it after the scroll refuses it', async () => {
    cards({ pageHeight: 3000 })
    page.place('#b', { x: 400, y: 850, w: 200, h: 40 })
    const banner = page.$('body').appendChild(page.$('#a').ownerDocument.createElement('div'))
    banner.textContent = 'Cookies'
    page.place(banner, { x: 0, y: 0, w: 1000, h: 50 }, { fixed: true })
    expect(await code(runPageOp('drag_points', { ref: ref('#a'), to_ref: ref('#b') }))).toBe('covered')
  })

  it('both ends must fit on one screen', async () => {
    cards({ pageHeight: 3000 })
    page.place('#b', { x: 400, y: 2500, w: 200, h: 100 })
    expect(await code(runPageOp('drag_points', { ref: ref('#a'), to_ref: ref('#b') }))).toBe('drag_offscreen')
  })
})

describe('slow typing', () => {
  const field = () => {
    page.load('<input id="code" name="code">')
    page.place('#code', { x: 10, y: 10, w: 200, h: 30 })
    return page.$('#code') as HTMLInputElement
  }

  it('a key at a time: keydown, keypress, input, keyup for each character', async () => {
    const el = field()
    const seen = recordEvents(['keydown', 'keyup'])
    const r = await typeSlowly(el, { text: 'ab' })
    expect(el.value).toBe('ab')
    expect(seen.slice(-4)).toEqual(['keydown a', 'keyup a', 'keydown b', 'keyup b'])
    expect(r.typed).toContain('2 characters')
  })

  it('a newline is the Enter key', async () => {
    const el = field()
    const seen = recordEvents(['keydown'])
    await typeSlowly(el, { text: 'a\nb' })
    expect(seen.slice(-3)).toEqual(['keydown a', 'keydown Enter', 'keydown b'])
    expect(el.value).toBe('ab')
  })

  it('stops before its next key once cancelled (a dialog cut the step short)', async () => {
    const el = field()
    const run = typeSlowly(el, { text: 'abcdef' })
    expect(cancelTyping()).toBe(true)
    expect(await code(run)).toBe('dialog_interrupted')
    expect(el.value).toBe('a')
    // A new run types again.
    await typeSlowly(el, { text: 'z' })
    expect(el.value).toBe('az')
    expect(cancelTyping()).toBe(false)
  })

  it('at most 200 characters', async () => {
    expect(await code(typeSlowly(field(), { text: 'x'.repeat(201) }))).toBe('too_long')
  })
})

describe('typing that sends waits for the person', () => {
  it('slowly: a newline in a message box is Enter, judged as a submit; at once it is only text', async () => {
    page.load('<textarea id="msg"></textarea>')
    page.place('#msg', { x: 10, y: 10, w: 300, h: 80 })
    const r = await runPageOp('type', { ref: ref('#msg'), text: 'hi there\n', slowly: true }) as R
    expect(r.hold).toMatchObject({ kind: 'send' })
    expect((page.$('#msg') as HTMLTextAreaElement).value).toBe('')
    // With the yes for exactly that step it types.
    const ok = await runPageOp('type', { ref: ref('#msg'), text: 'hi there\n', slowly: true, outward_ok: r.hold.sig }) as R
    expect(ok.hold).toBeUndefined()
    expect(ok.typed).toContain('one key at a time')
    const plain = await runPageOp('type', { ref: ref('#msg'), text: 'hi there\n' }) as R
    expect(plain.hold).toBeUndefined()
  })

  it('at a point: the click there and the Enter are one ask, and the one yes covers both', async () => {
    page.load('<div id="box" contenteditable="true" aria-label="Send a message"></div>')
    page.place('#box', { x: 100, y: 100, w: 300, h: 40 })
    const args = { x: 150, y: 120, text: 'hello', submit: true }
    const r = await runPageOp('type', args) as R
    expect(r.hold.kind).toBe('send')
    expect(r.hold.what).toMatch(/^click .*, then press Enter in /)
    expect(r.hold.message).toBe('hello')
    // The yes for the click alone is not the yes for the step.
    expect((await runPageOp('type', { ...args, outward_ok: String(r.hold.sig).split('&')[0] }) as R).hold).toBeDefined()
    const ok = await runPageOp('type', { ...args, outward_ok: r.hold.sig }) as R
    expect(ok.hold).toBeUndefined()
    expect(page.$('#box').textContent).toContain('hello')
  })

  it('real input at a point (locate with then_enter) asks the same one question, then puts the caret there', async () => {
    page.load('<div id="box" contenteditable="true" aria-label="Send a message"></div>')
    const box = page.place('#box', { x: 100, y: 100, w: 300, h: 40 })
    const args = { x: 150, y: 120, focus: true, outward: 'click', then_enter: true, typing: 'hello' }
    const r = await runPageOp('locate', args) as R
    expect(r.hold.what).toMatch(/then press Enter/)
    expect(page.$('#box').ownerDocument.activeElement).not.toBe(box)
    const ok = await runPageOp('locate', { ...args, outward_ok: r.hold.sig }) as R
    expect(ok).toMatchObject({ x: 150, y: 120 })
    expect(box.ownerDocument.activeElement).toBe(box)
  })

  it('a plain field at a point types with no ask', async () => {
    page.load('<input id="name" name="name">')
    page.place('#name', { x: 10, y: 10, w: 200, h: 30 })
    const r = await runPageOp('type', { x: 20, y: 20, text: 'Ana' }) as R
    expect(r.hold).toBeUndefined()
    expect((page.$('#name') as HTMLInputElement).value).toBe('Ana')
  })
})

describe('scroll inside a box', () => {
  const list = () => {
    page.load('<ul id="list" role="list" style="overflow-y: auto"><li id="item">Result 1</li></ul>', { pageHeight: 3000 })
    page.place('#list', { x: 0, y: 100, w: 400, h: 300 })
    page.scrollable('#list', { content: 2000, height: 300 })
    page.place('#item', { x: 0, y: 100, w: 400, h: 40 })
  }

  it('a ref and how far: the box around it scrolls, not the page', async () => {
    list()
    const r = await runPageOp('scroll', { ref: ref('#item'), direction: 'down', by: 300 }) as R
    expect(r.box).toContain('(ul)')
    expect(r.scrollTop).toBe(300)
    expect(page.$('#list').scrollTop).toBe(300)
    expect(page.scroll.y).toBe(0)
  })

  it('a point: the box under it', async () => {
    list()
    const r = await runPageOp('scroll', { x: 50, y: 150, direction: 'down', amount: 1 }) as R
    expect(r.box).toContain('(ul)')
    expect(page.$('#list').scrollTop).toBe(255)
  })

  it('a ref alone brings it into view, as before', async () => {
    list()
    await runPageOp('scroll', { ref: ref('#item') })
    expect(page.$('#list').scrollTop).toBe(0)
    expect(page.intoView).toBeGreaterThan(0)
  })
})
