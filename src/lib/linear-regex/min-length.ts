/**
 * The fewest characters a match consumes, read from the parsed tree with its counts as written
 * (before compile.ts clamps them): a caller that only ever tests texts shorter than this knows the
 * pattern can never match them. Assertions and lookarounds consume nothing.
 */
import type { Node } from './parse.js'

const CAP = 1e9

export function minMatchLength(node: Node): number {
  switch (node.type) {
    case 'empty':
    case 'assert':
    case 'look':
      return 0
    case 'char':
    case 'set':
      return 1
    case 'seq':
      return Math.min(CAP, node.items.reduce((sum, item) => sum + minMatchLength(item), 0))
    case 'alt':
      return node.items.reduce((least, item) => Math.min(least, minMatchLength(item)), CAP)
    case 'repeat':
      return node.min === 0 ? 0 : Math.min(CAP, node.min * minMatchLength(node.body))
  }
}

/**
 * Whether the pattern matches every text: it can match the empty string along a path with no
 * assertion or lookaround on it (`.*`, `invoice|`, all-optional parts), so it matches at the start of
 * any text. A path through `^`, `$`, `\b` or a lookaround depends on the text and does not count.
 */
export function matchesEveryText(node: Node): boolean {
  switch (node.type) {
    case 'empty':
      return true
    case 'assert':
    case 'look':
    case 'char':
    case 'set':
      return false
    case 'seq':
      return node.items.every(matchesEveryText)
    case 'alt':
      return node.items.some(matchesEveryText)
    case 'repeat':
      return node.min === 0 || matchesEveryText(node.body)
  }
}
