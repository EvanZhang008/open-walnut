/**
 * The parsed tree with every part that can only match the empty string folded away, before it is
 * compiled. The compiler counts the states it makes, and a part that makes none (`(?:)`, `a{0}`)
 * was free to expand: `(?:(?:(?:(?:(?:){999}){999}){999}){999}){999}`, 45 characters, built 301^5
 * copies of nothing. After this pass every repeat's body makes at least one state per copy and
 * every sequence item makes one, so the work of compiling is bounded by the states it makes.
 *
 * Each fold gives the same `test` answer (no back-references, so a group's capture changes nothing):
 *
 * - An `empty` item of a sequence matches nothing and moves nothing: dropped.
 * - `x{0}` never runs its body: empty.
 * - A repeat of a body that only matches empty (assertions and lookarounds at most): by the spec's
 *   RepeatMatcher, once `min` passes are done a pass that ends where it began fails, so exactly
 *   `min` passes run, all at one position, and asking the same assertions at one position again
 *   gives the same answer. So `{0,m}` is empty and `{n,m}` with n >= 1 is the body once.
 * - `x{1}` is exactly one pass: `x`. A sequence or alternation of one item is that item.
 *
 * What is left visits each part a few times at most per state it makes: a sequence or alternation
 * has two items or more, and every repeat makes a SPLIT state or at least two copies.
 */
import type { Node } from './parse.js'

/** Matches only the empty string: it never consumes a character. */
export function zeroWidth(node: Node): boolean {
  switch (node.type) {
    case 'empty': case 'assert': case 'look': return true
    case 'char': case 'set': return false
    case 'seq': case 'alt': return node.items.every(zeroWidth)
    case 'repeat': return node.max === 0 || zeroWidth(node.body)
  }
}

const EMPTY: Node = { type: 'empty' }

export function simplify(node: Node): Node {
  switch (node.type) {
    case 'empty': case 'char': case 'set': case 'assert': return node
    case 'look': return { ...node, body: simplify(node.body) }
    case 'seq': {
      const items = node.items.map(simplify).filter((item) => item.type !== 'empty')
      return items.length === 0 ? EMPTY : items.length === 1 ? items[0]! : { type: 'seq', items }
    }
    case 'alt': {
      const items = node.items.map(simplify)
      return items.length === 1 ? items[0]! : { type: 'alt', items }
    }
    case 'repeat': {
      if (node.max === 0) return EMPTY
      const body = simplify(node.body)
      if (zeroWidth(body)) return node.min >= 1 ? body : EMPTY
      if (node.min === 1 && node.max === 1) return body
      return { ...node, body }
    }
  }
}
