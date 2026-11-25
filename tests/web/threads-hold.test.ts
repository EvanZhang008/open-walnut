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

/** A fake card: a box from `top` to `bottom`, inside `root`. */
function fakeDom(cards: Array<{ id: string; top: number; bottom: number }>) {
  type El = { id: string; closest: (s: string) => El | null; getBoundingClientRect: () => { top: number; bottom: number } }
  const els: El[] = cards.map((c) => {
    const el: El = { id: c.id, closest: (s) => (s === THREAD_CARD_ROWS ? el : null), getBoundingClientRect: () => ({ top: c.top, bottom: c.bottom }) }
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
  it('is nothing when he is at neither: the list holds the top of the view, and nothing at the very top', () => {
    expect(readCard(d.root, null, d.doc(d.body, under))).toBeNull()
    expect(readCard(null, { x: 5, y: 5 }, d.doc(d.body, under))).toBeNull()
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
  const spec = fs.readFileSync(`${root}/tests/e2e/browser/threads-hold-matrix.spec.ts`, 'utf8')
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
    expect(hook).toContain('const onScroll = () => keep(box);')
    expect(hook).not.toMatch(/const onScroll = \(\) => \{ anchor\.current = pick\(box\); \};/)
  })

  it('the Threads list tells the anchor which card he reads', () => {
    const src = fs.readFileSync(`${root}/web/src/components/org/useThreadsHold.ts`, 'utf8')
    expect(src).toContain('useScrollAnchor(boxRef, THREAD_CARD_ROWS, false, () => readCard(rootRef.current, pointer.current))')
  })
})
