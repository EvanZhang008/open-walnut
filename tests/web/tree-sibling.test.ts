/**
 * Tree Mode's sibling page (web/src/utils/tree-sibling.ts): which sibling sits
 * above a page on screen (every column, 2026-11-16), at most one of them (2026-11-04, the user: "only show
 * the max 2, if there are 10 still show the current one and previous"), and a
 * swap trading the two places.
 */
import { describe, expect, it } from 'vitest'
import { buildThreadTree } from '@/utils/thread-tree'
import { clampSiblingShare, paneSiblings, siblingPartner, siblingRows, siblingsOf, SIBLING_MIN_PANEL_HEIGHT, SIBLING_SHARE_DEFAULT } from '@/utils/tree-sibling'
import { isTreeSplitRecord, NO_TREE_SPLIT, paneCap, paneCount, sameTreeSplit, roomFor } from '@/utils/tree-split-state'

/** Main's answer `a0`, with `n` questions asked on it (q1..qn), and one more under q1's answer. */
function treeWith(n: number) {
  const messages: Array<{ role: 'user' | 'assistant'; text: string; msgId: string }> = [
    { role: 'user', text: 'start', msgId: 'u0' },
    { role: 'assistant', text: 'answer', msgId: 'a0' },
  ]
  const anchors: Array<{ msgId: string; parent: string; quote: { exact: string }; source: 'selection'; at: string }> = []
  for (let i = 1; i <= n; i++) {
    messages.push({ role: 'user', text: `> passage ${i}\n\nq${i}`, msgId: `q${i}` }, { role: 'assistant', text: `r${i}`, msgId: `r${i}` })
    anchors.push({ msgId: `q${i}`, parent: 'a0', quote: { exact: `passage ${i}` }, source: 'selection', at: '2026-11-05T00:00:00.000Z' })
  }
  messages.push({ role: 'user', text: 'deep', msgId: 'd1' }, { role: 'assistant', text: 'deep answer', msgId: 'dr1' })
  anchors.push({ msgId: 'd1', parent: 'r1', quote: { exact: 'r1' }, source: 'selection', at: '2026-11-05T00:00:00.000Z' })
  const tree = buildThreadTree(messages, anchors)
  const keyOf = (head: string) => tree.threads.find((t) => t.headId === head)!.key
  return { tree, keyOf }
}

const NONE = new Set<string>()

describe('the sibling above the right page', () => {
  it('is the one asked just before it, else (the first) the one after it', () => {
    const { tree, keyOf } = treeWith(3)
    const [k1, k2, k3] = [keyOf('q1'), keyOf('q2'), keyOf('q3')]
    expect(siblingsOf(tree, k2, NONE)).toEqual([k1, k2, k3])
    expect(siblingPartner(tree, k2, NONE)).toEqual({ key: k1, position: 1, count: 3, before: true })
    expect(siblingPartner(tree, k3, NONE)).toEqual({ key: k2, position: 2, count: 3, before: true })
    expect(siblingPartner(tree, k1, NONE)).toEqual({ key: k2, position: 2, count: 3, before: false })
  })

  it('is one sibling even with ten (the rest are on the path bar\'s list)', () => {
    const { tree, keyOf } = treeWith(10)
    const p = siblingPartner(tree, keyOf('q10'), NONE)!
    expect(p.key).toBe(keyOf('q9'))
    expect(p.count).toBe(10)
    expect(p.position).toBe(9)
  })

  it('a swap trades the two places: the page the reader came from goes on top', () => {
    const { tree, keyOf } = treeWith(4)
    const [k1, k4] = [keyOf('q1'), keyOf('q4')]
    // From 4 the reader swapped to its sibling 3... and from 3 the swap stays on 4.
    expect(siblingPartner(tree, keyOf('q3'), NONE, k4)?.key).toBe(k4)
    // A swap memory that is not a sibling (or the page itself) is ignored.
    expect(siblingPartner(tree, keyOf('q3'), NONE, keyOf('d1'))?.key).toBe(keyOf('q2'))
    expect(siblingPartner(tree, k1, NONE, k1)?.key).toBe(keyOf('q2'))
  })

  it('none: Main, a question alone at its level, an unknown key; a hidden sibling is skipped', () => {
    const { tree, keyOf } = treeWith(2)
    expect(siblingPartner(tree, tree.rootKey, NONE)).toBeNull()
    expect(siblingPartner(tree, keyOf('d1'), NONE)).toBeNull()
    expect(siblingPartner(tree, 'nope', NONE)).toBeNull()
    expect(siblingPartner(tree, keyOf('q2'), new Set([keyOf('q1')]))).toBeNull()
    const three = treeWith(3)
    expect(siblingPartner(three.tree, three.keyOf('q3'), new Set([three.keyOf('q2')]))?.key).toBe(three.keyOf('q1'))
  })

  it('its share of the column: a third by default, kept between the bounds; rows as fr', () => {
    expect(clampSiblingShare(Number.NaN)).toBe(SIBLING_SHARE_DEFAULT)
    expect(clampSiblingShare(0.01)).toBe(0.15)
    expect(clampSiblingShare(0.99)).toBe(0.6)
    expect(siblingRows(1 / 3)).toEqual({ top: '0.5000fr', body: '1fr' })
  })

  it('the kept record carries the closed sibling and its share, and compares them', () => {
    expect(isTreeSplitRecord({ split: true, trail: [], sibling: false, siblingShare: 0.4 })).toBe(true)
    expect(isTreeSplitRecord({ split: true, trail: [], sibling: 'no' })).toBe(false)
    expect(isTreeSplitRecord({ split: true, trail: [], siblingShare: 2 })).toBe(false)
    expect(sameTreeSplit({ split: true, trail: [] }, { split: true, trail: [], sibling: false })).toBe(false)
    expect(sameTreeSplit({ split: true, trail: [], siblingShare: 0.3 }, { split: true, trail: [], siblingShare: 0.3 })).toBe(true)
  })
})

/** Main's answer with q1, q2 asked on it, and d1, d2 asked on q1's answer: Main > 1 > 1.1 with a sibling at both levels. */
function twoLevels() {
  const at = '2026-11-16T00:00:00.000Z'
  const messages: Array<{ role: 'user' | 'assistant'; text: string; msgId: string }> = [
    { role: 'user', text: 'start', msgId: 'u0' },
    { role: 'assistant', text: 'answer', msgId: 'a0' },
    { role: 'user', text: '> passage 1\n\nq1', msgId: 'q1' }, { role: 'assistant', text: 'r1 words', msgId: 'r1' },
    { role: 'user', text: '> passage 2\n\nq2', msgId: 'q2' }, { role: 'assistant', text: 'r2', msgId: 'r2' },
    { role: 'user', text: '> r1\n\nd1', msgId: 'd1' }, { role: 'assistant', text: 'dr1', msgId: 'dr1' },
    { role: 'user', text: '> words\n\nd2', msgId: 'd2' }, { role: 'assistant', text: 'dr2', msgId: 'dr2' },
  ]
  const anchors = [
    { msgId: 'q1', parent: 'a0', quote: { exact: 'passage 1' }, source: 'selection' as const, at },
    { msgId: 'q2', parent: 'a0', quote: { exact: 'passage 2' }, source: 'selection' as const, at },
    { msgId: 'd1', parent: 'r1', quote: { exact: 'r1' }, source: 'selection' as const, at },
    { msgId: 'd2', parent: 'r1', quote: { exact: 'words' }, source: 'selection' as const, at },
  ]
  const tree = buildThreadTree(messages, anchors)
  const keyOf = (head: string) => tree.threads.find((t) => t.headId === head)!.key
  return { tree, keyOf }
}

describe('every column has its sibling box (2026-11-16: "3 veirficle pannel, each pannel cna have 2 current and previous")', () => {
  const off = () => false

  it('his window (a 1568 x 1000 chat area) on 1.1: three columns, and each page with a sibling shows it above', () => {
    const { tree, keyOf } = twoLevels()
    const path = [tree.rootKey, keyOf('q1'), keyOf('d1')]
    const width = 1568
    const n = paneCount({ cap: paneCap(NO_TREE_SPLIT), width, pathLength: path.length })
    expect(n).toBe(3)
    const panes = path.slice(path.length - n)
    const boxes = paneSiblings(tree, panes, NONE, { room: Math.min(paneCap(NO_TREE_SPLIT), roomFor(width)), panelHeight: 1000, off })
    // Main has none; page 1 shows 2 above it (1 was asked first: the next one), page 1.1 shows 1.2.
    expect(boxes.map((b) => b.partner?.key ?? null)).toEqual([null, keyOf('q2'), keyOf('d2')])
    expect(boxes.every((b) => !b.closed)).toBe(true)
  })

  it('the previous sibling by default, the swapped-from one after a swap, per column', () => {
    const { tree, keyOf } = twoLevels()
    const panes = [tree.rootKey, keyOf('q2'), keyOf('d1')]
    const boxes = paneSiblings(tree, panes, NONE, { room: 3, panelHeight: 1000, off })
    expect(boxes[1].partner).toMatchObject({ key: keyOf('q1'), before: true, position: 1, count: 2 })
    const swapped = paneSiblings(tree, [tree.rootKey, keyOf('q1'), keyOf('d2')], NONE, {
      room: 3, panelHeight: 1000, off, swappedFrom: (k) => (k === keyOf('d2') ? keyOf('d1') : undefined),
    })
    expect(swapped[2].partner).toMatchObject({ key: keyOf('d1'), before: true })
  })

  it('a box the reader closed stays closed on that page only; none in a one-page view or a short panel', () => {
    const { tree, keyOf } = twoLevels()
    const panes = [tree.rootKey, keyOf('q1'), keyOf('d1')]
    const closed = paneSiblings(tree, panes, NONE, { room: 3, panelHeight: 1000, off: (k) => k === keyOf('q1') })
    expect(closed.map((b) => [b.partner?.key ?? null, b.closed])).toEqual([[null, false], [null, true], [keyOf('d2'), false]])
    expect(paneSiblings(tree, panes.slice(2), NONE, { room: 1, panelHeight: 1000, off }).every((b) => !b.partner && !b.closed)).toBe(true)
    const short = paneSiblings(tree, panes, NONE, { room: 3, panelHeight: SIBLING_MIN_PANEL_HEIGHT - 1, off })
    expect(short.every((b) => !b.partner)).toBe(true)
    // A hidden sibling is no box.
    expect(paneSiblings(tree, panes, new Set([keyOf('q2')]), { room: 3, panelHeight: 1000, off })[1].partner).toBeNull()
  })
})
