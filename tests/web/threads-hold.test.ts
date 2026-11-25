/**
 * A Threads list holds still while he reads it (web/src/components/org/useThreadsHold.ts; 2026-11-23,
 * the user: "keep this location from changing, or it keeps flashing"; 2026-11-25: a new card above
 * "still pushes my page out"). The pure order step, which card he reads (the focus's, the pointer's),
 * the hold's reasons (pointer or focus), and a guard that every list OrgThreads draws goes through
 * the hold (a list added beside them would move under his pointer again). The browser half: tests/e2e/browser/threads-hold-still.spec.ts.
 */
import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { inHeldOrder, readCard, THREAD_CARD_ROWS } from '../../web/src/components/org/useThreadsHold'
import { stepHold } from '../../web/src/components/org/hold-order'
import { anchoredScrollTop, enginePull, heldPlace, holdsRows, releaseScrollTop, SCROLL_INPUT_EVENTS, slackStep, stepScrollInput, type ScrollInput } from '../../web/src/hooks/scroll-anchor'
import { THREAD_GROUPS } from '../../src/core/org/thread-groups'
import type { OrgThread } from '../../web/src/api/org-threads'

const t = (id: string) => ({ id }) as OrgThread

describe('the held order of a Threads list', () => {
  it('keeps the held places, puts a newcomer after them in its own order, and drops one that left', () => {
    const at = new Map([['a', 0], ['b', 1], ['c', 2]])
    expect(inHeldOrder([t('c'), t('x'), t('a'), t('y'), t('b')], at).map((x) => x.id)).toEqual(['a', 'b', 'c', 'x', 'y'])
    expect(inHeldOrder([t('c'), t('a')], at).map((x) => x.id)).toEqual(['a', 'c'])
    // No hold: the list as it came (the map is its own order).
    const own = new Map([['c', 0], ['a', 1]])
    expect(inHeldOrder([t('c'), t('a')], own).map((x) => x.id)).toEqual(['c', 'a'])
  })

  it('anchors on the cards themselves', () => {
    expect(THREAD_CARD_ROWS).toBe('[data-testid="org-thread"]')
  })

  it('every list OrgThreads draws of open threads goes through the hold', () => {
    const src = fs.readFileSync(`${process.cwd()}/web/src/components/org/OrgThreads.tsx`, 'utf8')
    expect(src).toContain('const hold = useThreadsHold(rootRef, open, groups)')
    // The pointer and the focus both reach the hold: the root spreads every handler.
    expect(src).toContain('onClick={onEntityClick} {...hold.handlers}>')
    expect(src).toMatch(/groups=\{hold\.groups\}/)
    expect(src).toMatch(/\{hold\.open\.map\(/)
    // The open list and the groups are never drawn from the unheld arrays.
    expect(src).not.toMatch(/\{open\.map\(\(t\) => card\(t\)\)\}/)
    expect(src).not.toMatch(/groups=\{groups\}/)
  })

  it('the boxes that scroll a Threads list leave Chromium\'s own anchoring off (one keeper in both engines)', () => {
    const css = fs.readFileSync(`${process.cwd()}/web/src/styles/org-threads.css`, 'utf8')
    expect(css).toContain('.org-rail-body:has(> .org-threads), .session-threads-body:has(> .org-threads) { overflow-anchor: none; }')
  })
})

/** A fake card: a box from `top` to `bottom`, inside `root` (`box: false`: drawn with no box, inside a fold). */
function fakeDom(cards: Array<{ id: string; top: number; bottom: number; box?: boolean }>) {
  type El = { id: string; closest: (s: string) => El | null; getBoundingClientRect: () => { top: number; bottom: number }; getClientRects: () => unknown[] }
  const els: El[] = cards.map((c) => {
    const none = c.box === false
    const el: El = { id: c.id, closest: (s) => (s === THREAD_CARD_ROWS ? el : null), getBoundingClientRect: () => (none ? { top: 0, bottom: 0 } : { top: c.top, bottom: c.bottom }), getClientRects: () => (none ? [] : [{}]) }
    return el
  })
  const inner = { id: 'box-in-b', tagName: 'TEXTAREA', closest: (s: string) => (s === THREAD_CARD_ROWS ? els[1] : null) }
  // A fold's head the keyboard moved to.
  const head = { id: 'group-head', tagName: 'BUTTON', matches: (q: string) => q === ':focus-visible', closest: () => null }
  // A card's button Chromium focused on a click.
  const clicked = { id: 'clicked-in-a', tagName: 'BUTTON', matches: () => false, closest: (s: string) => (s === THREAD_CARD_ROWS ? els[0] : null) }
  const body = { id: 'body' }
  const root = { contains: (x: unknown) => x === inner || x === head || x === clicked || els.includes(x as El), querySelectorAll: () => els } as unknown as HTMLElement
  const doc = (active: unknown, at: (y: number) => unknown) => ({ activeElement: active, body, elementFromPoint: (_x: number, y: number) => at(y) }) as unknown as Document
  return { els, inner, head, clicked, body, root, doc }
}

describe('the card he reads', () => {
  const d = fakeDom([{ id: 'a', top: 0, bottom: 100 }, { id: 'b', top: 110, bottom: 200 }, { id: 'c', top: 210, bottom: 300 }])
  const under = (y: number) => d.els.find((e) => e.getBoundingClientRect().top <= y && e.getBoundingClientRect().bottom > y) ?? d.head
  it('is the card holding the focus, wherever the pointer is', () => {
    expect((readCard(d.root, { x: 5, y: 250 }, d.doc(d.inner, under)) as unknown as { id: string }).id).toBe('b')
  })
  it('is the card under the pointer when the focus is not in the list, or is a clicked button\'s', () => {
    expect((readCard(d.root, { x: 5, y: 250 }, d.doc(d.body, under)) as unknown as { id: string }).id).toBe('c')
    expect((readCard(d.root, { x: 5, y: 250 }, d.doc(d.clicked, under)) as unknown as { id: string }).id).toBe('c')
    expect(readCard(d.root, null, d.doc(d.clicked, under))).toBeNull()
  })
  it('between cards (a group head, a line), is the first card below the pointer', () => {
    expect((readCard(d.root, { x: 5, y: 105 }, d.doc(d.body, under)) as unknown as { id: string }).id).toBe('b')
  })
  it('a focused element that is no card (a fold\'s head) is held itself', () => {
    expect(readCard(d.root, null, d.doc(d.head, under))).toBe(d.head)
  })
  // 2026-11-25, a review: below every card (a folded group's head under Done) the list itself was
  // held, whose top never moves, and a new card above pushed everything he saw by its height.
  it('below every card (a fold\'s head under them), is the card right above the pointer', () => {
    expect((readCard(d.root, { x: 5, y: 900 }, d.doc(d.body, under)) as unknown as { id: string }).id).toBe('c')
  })
  it('below every card, skips a card drawn with no box (inside a folded group)', () => {
    const f = fakeDom([{ id: 'a', top: 0, bottom: 100 }, { id: 'b', top: 110, bottom: 200 }, { id: 'folded', top: 0, bottom: 0, box: false }])
    expect((readCard(f.root, { x: 5, y: 400 }, f.doc(f.body, () => f.head)) as unknown as { id: string }).id).toBe('b')
    // Between cards, a boxless one is never the card below either.
    const g = fakeDom([{ id: 'a', top: 0, bottom: 100 }, { id: 'folded', top: 0, bottom: 0, box: false }, { id: 'c', top: 210, bottom: 300 }])
    expect((readCard(g.root, { x: 5, y: 150 }, g.doc(g.body, () => g.head)) as unknown as { id: string }).id).toBe('c')
  })
  it('with no card at all (or none with a box), is the list itself: he is still at it', () => {
    const e = fakeDom([])
    expect(readCard(e.root, { x: 5, y: 50 }, e.doc(e.body, () => e.head))).toBe(e.root)
    const f = fakeDom([{ id: 'folded', top: 0, bottom: 0, box: false }])
    expect(readCard(f.root, { x: 5, y: 50 }, f.doc(f.body, () => f.head))).toBe(f.root)
  })
  it('is nothing when he is at neither: the list holds the top of the view, and nothing at the very top', () => {
    expect(readCard(d.root, null, d.doc(d.body, under))).toBeNull()
    expect(readCard(null, { x: 5, y: 5 }, d.doc(d.body, under))).toBeNull()
  })
})

// What readCard returns for "he is at the list" with no card to hold (the list itself) is never held
// as a row: its top does not move when cards come and go inside it (useScrollAnchor's readAnchor).
describe('a box or a list of rows is never the row being read', () => {
  const el = (inner: unknown) => ({ querySelector: (s: string) => (s === THREAD_CARD_ROWS ? inner : null) }) as unknown as Element
  const box = el({}) as unknown as HTMLElement
  it('the box itself, or anything holding a row, is a container', () => {
    expect(holdsRows(box, THREAD_CARD_ROWS, box)).toBe(true)
    expect(holdsRows(box, THREAD_CARD_ROWS, el({}))).toBe(true)
  })
  it('a card (no row inside) or a fold\'s head is a row to hold', () => {
    expect(holdsRows(box, THREAD_CARD_ROWS, el(null))).toBe(false)
  })
})

// WebKit pulls a box at its end up by the height of a card moved in the DOM above the view (his
// leaving lets the order follow, a card goes to another group), and never gives it back: on a
// commit, that pull is no scroll of his, and the card goes back where he saw it.
describe('a pull at the end of the range that no input made', () => {
  const mark = { atEnd: true, at: 1000 }
  const none = { at: 500, down: false }
  it('is the engine\'s when the mark sat at the end, the commit moved the box up, and nothing scrolled since', () => {
    expect(enginePull(mark, 5056, 4670, none)).toBe(386)
    // Taken out of the mark's scroll, the card goes back where it stood on screen.
    expect(anchoredScrollTop({ top: 200, scrollTop: 5056 - 386 }, 586, 4670, 5056)).toBe(5056)
  })
  it('a scroll made before the commit\'s render (a jump of the page, a test) is never undone', () => {
    // Scrolled to the top, then a commit that moved nothing.
    expect(enginePull(mark, 0, 0, none)).toBe(0)
    // Scrolled a little up, then a commit that pulled 193 more: only the pull.
    expect(enginePull(mark, 4800, 4607, none)).toBe(193)
  })
  it('is his after a wheel, a key, a touch or with a pointer held down (a scrollbar drag)', () => {
    expect(enginePull(mark, 5056, 4670, { at: 1200, down: false })).toBe(0)
    expect(enginePull(mark, 5056, 4670, { at: 500, down: true })).toBe(0)
  })
  it('is none when the mark was not at the end, nothing was read before the commit, or the box is not higher', () => {
    expect(enginePull({ ...mark, atEnd: false }, 5056, 4670, none)).toBe(0)
    expect(enginePull({}, 5056, 4670, none)).toBe(0)
    expect(enginePull(mark, null, 4670, none)).toBe(0)
    expect(enginePull(mark, 5056, 5056, none)).toBe(0)
    expect(enginePull(mark, 5056, 5200, none)).toBe(0)
  })
  it('is read on a commit only, in a box that knows the row being read', () => {
    const hook = fs.readFileSync(`${process.cwd()}/web/src/hooks/useScrollAnchor.ts`, 'utf8')
    expect(hook).toContain('commit && readingRef.current ? enginePull(held, before.current, box.scrollTop, input.current) : 0')
    expect(hook.match(/keep\(box, true\)/g)).toHaveLength(1)
  })
})

// 2026-11-25, a review: a press with no release (a ctrl-click's context menu, a native drag on macOS)
// left the pointer down, and the engine's pull was never taken out again until his next click.
describe('a pointer held down, and what lets it go', () => {
  const step = (events: Array<string | [string, number]>, from: ScrollInput = { at: 0, down: false }) =>
    events.reduce((input, e, i) => stepScrollInput(input, typeof e === 'string' ? { type: e } : { type: e[0], buttons: e[1] }, 100 * (i + 1)), from)
  it('a press holds it down until it goes up, is cancelled, or a native drag ends', () => {
    expect(step(['pointerdown'])).toEqual({ at: 100, down: true })
    expect(step(['pointerdown', 'pointerup'])).toEqual({ at: 100, down: false })
    expect(step(['pointerdown', 'pointercancel'])).toEqual({ at: 100, down: false })
    expect(step(['pointerdown', 'dragend'])).toEqual({ at: 100, down: false })
  })
  it('a press with no release lets go at the next move with no button, wheel or key', () => {
    expect(step(['pointerdown', ['pointermove', 0]]).down).toBe(false)
    expect(step(['pointerdown', 'wheel'])).toEqual({ at: 200, down: false })
    expect(step(['pointerdown', 'keydown'])).toEqual({ at: 200, down: false })
    // A move with a button pressed is a drag: still down.
    expect(step(['pointerdown', ['pointermove', 1]]).down).toBe(true)
  })
  it('a letter typed in a text field is no scroll; a key that moves its caret by lines is, and so is any key elsewhere', () => {
    const typed = stepScrollInput({ at: 0, down: false }, { type: 'keydown', key: 'n', inField: true }, 500)
    expect(typed).toEqual({ at: 0, down: false })
    expect(stepScrollInput({ at: 0, down: true }, { type: 'keydown', key: 'n', inField: true }, 500)).toEqual({ at: 0, down: false })
    expect(stepScrollInput({ at: 0, down: false }, { type: 'keydown', key: 'PageDown', inField: true }, 500)).toEqual({ at: 500, down: false })
    expect(stepScrollInput({ at: 0, down: false }, { type: 'keydown', key: ' ' }, 500)).toEqual({ at: 500, down: false })
    // So the engine's pull, at the end of the list, is still put back while he types.
    expect(enginePull({ atEnd: true, at: 100 }, 5056, 4670, typed)).toBe(386)
  })
  it('a move stamps no time (it scrolls nothing), a touch does and keeps the press', () => {
    expect(step([['pointermove', 0]])).toEqual({ at: 0, down: false })
    expect(step(['pointerdown', 'touchmove'])).toEqual({ at: 200, down: true })
  })
  it('after a context menu\'s press, the engine\'s pull is put back again once the pointer moves', () => {
    const mark = { atEnd: true, at: 1000 }
    const pressed = step(['pointerdown'])
    expect(enginePull(mark, 5056, 4670, pressed)).toBe(0)
    expect(enginePull(mark, 5056, 4670, stepScrollInput(pressed, { type: 'pointermove', buttons: 0 }, 900))).toBe(386)
  })
  it('the hook steps its input on every one of these events, on the window', () => {
    const hook = fs.readFileSync(`${process.cwd()}/web/src/hooks/useScrollAnchor.ts`, 'utf8')
    expect(hook).toContain('for (const t of SCROLL_INPUT_EVENTS) window.addEventListener(t, onInput, { capture: true, passive: true })')
    expect(hook).toContain('stepScrollInput(input.current,')
    expect([...SCROLL_INPUT_EVENTS]).toEqual(expect.arrayContaining(['wheel', 'keydown', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dragend', 'touchstart', 'touchmove']))
  })
})

// 2026-11-25, a review: the card he reads (a Needs you card he answers) went to another group and was
// drawn again there; the hold let go with no correction, and every card he saw moved by 186px.
describe('the place of the card he reads, once that card leaves it', () => {
  const at = (el: string | null, top: number | undefined, ok: boolean) => ({ el, top, ok })
  it('is the card itself while it is there and in its order', () => {
    expect(heldPlace([at('his', 200, true), at('next', 400, true), at('prev', 50, true)])).toEqual({ el: 'his', top: 200 })
  })
  it('is the card drawn right before it once it left, else the one right after it', () => {
    expect(heldPlace([at('his', 200, false), at('prev', 50, true), at('next', 400, true)])).toEqual({ el: 'prev', top: 50 })
    expect(heldPlace([at('his', 200, false), at(null, undefined, false), at('next', 400, true)])).toEqual({ el: 'next', top: 400 })
    // A neighbour with no box when it was picked (inside a fold) was never measured: not a place.
    expect(heldPlace([at('his', 200, false), at('prev', undefined, true), at('next', 400, true)])).toEqual({ el: 'next', top: 400 })
  })
  it('is nothing when none of them is still there: a row is picked afresh', () => {
    expect(heldPlace([at('his', 200, false), at('next', 400, false), at('prev', 50, false)])).toBeNull()
    expect(heldPlace([])).toBeNull()
  })
  // 2026-11-25: holding the card after a tall one pushed the cards above it down, with room at the top.
  it('the hook asks for it for the row being read only, the card before it first, and keeps it until he moves or scrolls', () => {
    const hook = fs.readFileSync(`${process.cwd()}/web/src/hooks/useScrollAnchor.ts`, 'utf8')
    expect(hook).toMatch(/\.\.\.\(held\.read \? \[\{ el: held\.prev, top: held\.prevTop[^\n]*\{ el: held\.next, top: held\.nextTop/)
    expect(hook).toContain('if (!mine && anchor.current) anchor.current.stand = false;')
  })
})

describe('the reasons a list is held', () => {
  const none = { pointer: false, focus: false }
  it('the first reason takes the order, a second keeps it, the last to go lets it follow', () => {
    const a = stepHold(none, 'focus', true)
    expect(a).toEqual({ reasons: { pointer: false, focus: true }, act: 'take' })
    const b = stepHold(a.reasons, 'pointer', true)
    expect(b.act).toBe('keep')
    const c = stepHold(b.reasons, 'pointer', false)
    expect(c).toEqual({ reasons: { pointer: false, focus: true }, act: 'keep' })
    expect(stepHold(c.reasons, 'focus', false)).toEqual({ reasons: none, act: 'free' })
  })
  it('a reason that was not there going away changes nothing', () => {
    expect(stepHold(none, 'pointer', false).act).toBe('keep')
  })
})

// The browser matrix (tests/e2e/browser/threads-hold-matrix.spec.ts) is the guard of the position:
// every kind of element the list draws, and every group, must be a change it runs above a card.
describe('the hold-still matrix covers everything that can stand above a card', () => {
  const root = process.cwd()
  // Its columns (CHANGES) and the tables naming one for every element and group live beside it.
  const spec = fs.readFileSync(`${root}/tests/e2e/browser/threads-hold-changes.ts`, 'utf8')
  const table = (name: string) => {
    const body = spec.slice(spec.indexOf(`const ${name}`), spec.indexOf('\n}\n', spec.indexOf(`const ${name}`)))
    return new Map([...body.matchAll(/^\s+'?([\w-]+)'?: '([^']+)',$/gm)].map((m) => [m[1], m[2]]))
  }
  const changes = new Set([...spec.matchAll(/^\s+name: '([^']+)',/gm)].map((m) => m[1]))
  const covered = (change: string) => change.startsWith('none: ') || changes.has(change)

  it('every element kind OrgThreadsByState and OrgThreadsWatching draw has its row and its change', () => {
    const kinds = new Set<string>()
    for (const f of ['OrgThreadsByState.tsx', 'OrgThreadsWatching.tsx']) {
      const src = fs.readFileSync(`${root}/web/src/components/org/${f}`, 'utf8')
      for (const m of src.matchAll(/(?:data-testid|testId)="([\w-]+)"/g)) kinds.add(m[1])
    }
    const rows = table('ABOVE_A_CARD')
    expect([...kinds].filter((k) => !rows.has(k)), 'element kinds with no row in ABOVE_A_CARD').toEqual([])
    expect([...rows].filter(([, c]) => !covered(c)).map(([k]) => k), 'rows naming no change of CHANGES').toEqual([])
  })

  it('every group (and Watching) has its row and its change', () => {
    const rows = table('GROUPS_ABOVE')
    expect([...THREAD_GROUPS, 'watching'].filter((g) => !rows.has(g))).toEqual([])
    expect([...rows].filter(([, c]) => !covered(c)).map(([g]) => g)).toEqual([])
  })

  it('a scroll event puts the row back before it picks again (a commit between the two moved it)', () => {
    const hook = fs.readFileSync(`${root}/web/src/hooks/useScrollAnchor.ts`, 'utf8')
    expect(hook).toMatch(/const onScroll = \(\) => \{[\s\S]*?\n      keep\(box\);\n    \};/)
    expect(hook).not.toMatch(/const onScroll = \(\) => \{ anchor\.current = pick\(box\); \};/)
  })

  it('the Threads list tells the anchor which card he reads', () => {
    const src = fs.readFileSync(`${root}/web/src/components/org/useThreadsHold.ts`, 'utf8')
    expect(src).toContain('useScrollAnchor(boxRef, THREAD_CARD_ROWS, false, () => readCard(rootRef.current, pointer.current))')
  })
})

// What no scroll can hold (a card above left while he read near the top) the box holds with room
// at its top, while he is at the list; leaving lets it go (useScrollAnchor).
describe('room at the top for the card he reads', () => {
  it('takes what the scroll lacks, and gives it back first when something above grows again', () => {
    // At 20px a card of 300px above leaves: the scroll can go up 20px, the room takes the other 280.
    const raw = anchoredScrollTop({ top: 400, scrollTop: 20 }, 100, 20, 5000, -Infinity)
    expect(raw).toBe(-280)
    expect(slackStep(0, raw)).toEqual({ slack: 280, scrollTop: 0 })
    // Nothing more moved: the room stays.
    expect(slackStep(280, 0)).toEqual({ slack: 280, scrollTop: 0 })
    // A new card of 120px above: the room shrinks, nothing scrolls.
    expect(slackStep(280, 120)).toEqual({ slack: 160, scrollTop: 0 })
    // One taller than the room: the room goes, the rest is scrolled.
    expect(slackStep(160, 250)).toEqual({ slack: 0, scrollTop: 90 })
    // Nothing moved: nothing changes.
    expect(slackStep(0, 40)).toEqual({ slack: 0, scrollTop: 40 })
  })
  it('the usual hold never goes below the top', () => {
    expect(anchoredScrollTop({ top: 400, scrollTop: 20 }, 100, 20, 5000)).toBe(0)
  })
  it('leaving goes back to the very top when he was there and did not scroll; else nothing on screen moves', () => {
    expect(releaseScrollTop({ fromTop: true, scrolled: false }, 0, 194)).toBe(0)
    expect(releaseScrollTop({ fromTop: true, scrolled: false }, 300, 0)).toBe(0)
    expect(releaseScrollTop({ fromTop: true, scrolled: true }, 0, 194)).toBe(194)
    expect(releaseScrollTop({ fromTop: false, scrolled: false }, 0, 800)).toBe(800)
    // The room goes with the hold: the scroll takes it out, so the rows stay where they are.
    expect(releaseScrollTop({ fromTop: false, scrolled: true }, 100, 640)).toBe(540)
  })
})
