/**
 * Patterns handed to the native engine instead of the NFA, for speed: literal rules and short
 * alternations such as `(confirm|verify) your (email|account)` and `\b\d{1,2}% off\b`.
 *
 * What is proven, and what is only measured. For a pattern with no lookaround, no back-reference
 * and no unbounded quantifier, a backtracking matcher explores, from one start position, a finite
 * tree: one branch per alternative and one per allowed count of a counted repeat. `leaves` bounds
 * its leaves (sum for an alternation, product for a sequence, max - min + 1 for a repeat of one
 * character) and `steps` one root-to-leaf path, so one start visits at most leaves x steps choice
 * points. That counts choice points, not the engine's cost per point, and that cost (in
 * JavaScriptCore, which runs the server) is not constant: a quantified group pays per pass for
 * every group nested in it (20 nested groups under `{236}` took 286 ms on 300 characters,
 * 2026-11-04). So the fast path takes only the shapes where that cost is small: every repeat is of
 * one character or class, never of a group (no quantifier right after `)`), and there are at most
 * MAX_GROUPS groups. On those, the timing test (tests/lib/linear-regex-timing.test.ts, "at the fast
 * path limits") measures the worst: 1.3 ms on 300 characters (2026-11-04). The count bound itself
 * is (300 + 1) x 16 x 256 choice points on a mail subject. Anything else runs in the NFA, whose
 * cost does not depend on the engine.
 */
import type { Node } from './parse.js'

export const MAX_LEAVES = 16
export const MAX_STEPS = 256
export const MAX_GROUPS = 8

interface Bound { leaves: number; steps: number }

const NONE: Bound = { leaves: Infinity, steps: Infinity }
/** Saturate, so huge counts never overflow into something small. */
const cap = (value: number): number => Math.min(value, 1e9)

function bound(node: Node): Bound {
  switch (node.type) {
    case 'empty': case 'char': case 'set': case 'assert': return { leaves: 1, steps: 1 }
    case 'look': return NONE
    case 'seq': {
      let leaves = 1
      let steps = 0
      for (const item of node.items) {
        const part = bound(item)
        leaves = cap(leaves * part.leaves)
        steps = cap(steps + part.steps)
      }
      return { leaves, steps }
    }
    case 'alt': {
      const parts = node.items.map(bound)
      return { leaves: cap(parts.reduce((sum, part) => sum + part.leaves, 0)), steps: cap(1 + Math.max(...parts.map((part) => part.steps))) }
    }
    case 'repeat': {
      // One character or class per pass, a bounded count: max - min + 1 choices, max steps.
      if (node.max === Infinity || (node.body.type !== 'char' && node.body.type !== 'set')) return NONE
      return { leaves: cap(node.max - node.min + 1), steps: cap(1 + node.max) }
    }
  }
}

/**
 * The groups of `source` and whether any is quantified (a `?`, `*`, `+` or `{` right after its
 * `)`), read as the native engine tokenizes: `\` escapes one character, `[...]` holds no groups.
 */
function groupShape(source: string): { groups: number; quantifiedGroup: boolean } {
  let groups = 0
  let quantifiedGroup = false
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]
    if (c === '\\') { i += 1; continue }
    if (c === '[') {
      for (i += 1; i < source.length && source[i] !== ']'; i += 1) if (source[i] === '\\') i += 1
      continue
    }
    if (c === '(') groups += 1
    else if (c === ')' && /[?*+{]/.test(source[i + 1] ?? '')) quantifiedGroup = true
  }
  return { groups, quantifiedGroup }
}

/** Whether `test` may run this pattern natively (on a whole text, never a cut one). */
export function boundedForBacktracking(tree: Node, source: string): boolean {
  const shape = groupShape(source)
  if (shape.quantifiedGroup || shape.groups > MAX_GROUPS) return false
  const { leaves, steps } = bound(tree)
  return leaves <= MAX_LEAVES && steps <= MAX_STEPS
}
