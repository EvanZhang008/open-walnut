/**
 * Tree Mode's sibling page (web/src/utils/tree-sibling.ts): which sibling sits
 * above the right page, at most one of them (2026-11-04, the user: "only show
 * the max 2, if there are 10 still show the current one and previous"), and a
 * swap trading the two places.
 */
import { describe, expect, it } from 'vitest'
import { buildThreadTree } from '@/utils/thread-tree'
import { clampSiblingShare, siblingPartner, siblingRows, siblingsOf, SIBLING_SHARE_DEFAULT } from '@/utils/tree-sibling'
import { isTreeSplitRecord, sameTreeSplit } from '@/utils/tree-split-state'

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
