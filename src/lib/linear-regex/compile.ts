/**
 * The parsed pattern as Thompson NFAs: one program for the pattern and one per lookaround body
 * (innermost first, so each lookaround's answers exist before a program that asks them).
 *
 * Counted repeats are expanded into copies, clamped by the longest text the matcher accepts (L):
 *
 * - A body that consumes at least w >= 1 characters per pass fits at most floor(L/w) whole passes
 *   into any span of the text, so counts above floor(L/w) + 1 change nothing: with min above it no
 *   copy count completes either way, and the one pass beyond the floor is kept so a path that runs
 *   off the end of a cut text mid-pass (a lookahead's "could still match", match.ts) still exists.
 * - A body that may match empty makes at most L consuming passes; any further pass is empty, and an
 *   empty pass at one position can be dropped or repeated (same position, same assertions). So any
 *   path of n >= L + 1 passes keeps one empty pass and at most L consuming ones, and pads back to
 *   any count >= L + 1: every count from L + 1 up is the same, and counts clamp to L + 1.
 * - An upper count of at least `fits` (floor(L/w) for a consuming body, L + 1 for one that may be
 *   empty) is as good as none: no span of a whole text holds more passes (or, by the rule above,
 *   needs more), so `{n,m}` with m >= fits is compiled as `{n,}`, a loop: `.{0,300}` is two states,
 *   not 602. On a cut text the forward runs and every `lo` run see spans inside the cut, so they
 *   are exact too; only a lookahead body's "alive at the cut" (`hi`, match.ts) may then hold where
 *   the real count would have stopped it, which widens `hi` and so can only lose a match.
 *
 * The programs stop at `maxStates` nodes in all (`TooManyStates`), a lookaround body's counted twice:
 * a test costs O(text length x that count). The tree is simplified first (simplify.ts), so every
 * part the builder visits makes a state and compiling costs O(states) too (`work` counts the visits).
 */
import { asciiCanon, canonical } from './case-fold.js'
import { contains, type Ranges } from './charset.js'
import type { AssertKind, Node } from './parse.js'
import { simplify } from './simplify.js'

export const CHAR = 0
export const SPLIT = 1
export const ASSERT = 2
export const MATCH = 3

/** ASSERT `arg` values below LOOK_BASE are the base assertions; `LOOK_BASE + k` is lookaround k. */
export const ASSERT_IDS: Record<AssertKind, number> = { start: 0, 'start-m': 1, end: 2, 'end-m': 3, word: 4, nonword: 5 }
export const LOOK_BASE = 8

export interface Pred {
  /** A literal's code unit (its canonical form when `ci`), or -1 for a set. */
  code: number
  ci: boolean
  ranges: Ranges
  negate: boolean
  /** The answer for every ASCII text code unit. */
  ascii: Uint8Array
  /** Matches no code unit at all (`[]`). */
  never: boolean
  /** A set whose members are all ASCII. */
  asciiOnly: boolean
}

export interface Program {
  size: number
  kind: Uint8Array
  out: Int32Array
  out2: Int32Array
  arg: Int32Array
  start: number
  /** CHAR nodes that can match something (a cut text's last position: match.ts). */
  chars: Int32Array
  /** Predecessors, for running a lookahead body backward. */
  predStart: Int32Array
  predList: Int32Array
}

export interface Look { program: Program; behind: boolean; negate: boolean }

export interface CompiledPattern {
  main: Program
  looks: Look[]
  preds: Pred[]
  /** `preds[p].ascii` for every pred, flat: the answer for ASCII code unit c is at `(p << 7) | c`. */
  asciiTable: Uint8Array
  states: number
  /** Builder visits: a guard test holds them to a small multiple of `states`. */
  work: number
  /** Every match starts at position 0. */
  anchored: boolean
}

export class TooManyStates extends Error {}

function makePred(node: Extract<Node, { type: 'char' | 'set' }>): Pred {
  const ascii = new Uint8Array(128)
  if (node.type === 'char') {
    const code = node.ci ? canonical(node.code) : node.code
    for (let ch = 0; ch < 128; ch += 1) ascii[ch] = (node.ci ? asciiCanon(ch) === code : ch === code) ? 1 : 0
    return { code, ci: node.ci, ranges: [], negate: false, ascii, never: false, asciiOnly: code < 128 }
  }
  for (let ch = 0; ch < 128; ch += 1) {
    // ASCII letters fold only with each other (no code unit >= 128 folds to one under 128).
    const other = node.ci ? (ch >= 0x61 && ch <= 0x7a ? ch - 32 : ch >= 0x41 && ch <= 0x5a ? ch + 32 : ch) : ch
    const found = contains(node.ranges, ch) || contains(node.ranges, other)
    ascii[ch] = found !== node.negate ? 1 : 0
  }
  const never = node.negate ? node.ranges.length === 2 && node.ranges[0] === 0 && node.ranges[1] === 0xffff : node.ranges.length === 0
  const asciiOnly = node.ranges.length === 0 || node.ranges[node.ranges.length - 1]! < 128
  return { code: -1, ci: node.ci, ranges: node.ranges, negate: node.negate, ascii, never, asciiOnly }
}

function minWidthOf(node: Node, memo: Map<Node, number>): number {
  let width = memo.get(node)
  if (width !== undefined) return width
  switch (node.type) {
    case 'char': case 'set': width = 1; break
    case 'seq': width = node.items.reduce((sum, item) => Math.min(sum + minWidthOf(item, memo), Number.MAX_SAFE_INTEGER), 0); break
    case 'alt': width = node.items.reduce((least, item) => Math.min(least, minWidthOf(item, memo)), Infinity); break
    case 'repeat': width = node.min === 0 ? 0 : Math.min(node.min * minWidthOf(node.body, memo), Number.MAX_SAFE_INTEGER); break
    default: width = 0
  }
  memo.set(node, width)
  return width
}

function anchoredAtStart(node: Node): boolean {
  switch (node.type) {
    case 'assert': return node.kind === 'start'
    case 'seq': return node.items.length > 0 && anchoredAtStart(node.items[0]!)
    case 'alt': return node.items.every(anchoredAtStart)
    case 'repeat': return node.min >= 1 && anchoredAtStart(node.body)
    default: return false
  }
}

class Builder {
  readonly kind: number[] = []
  readonly out: number[] = []
  readonly out2: number[] = []
  readonly arg: number[] = []

  /** `weight`: a lookaround body runs twice on a cut text (match.ts), so its nodes count twice. */
  constructor(private readonly ctx: Context, private readonly weight: number) {}

  add(kind: number, out: number, out2: number, arg: number): number {
    this.ctx.used += 1
    if ((this.ctx.cost += this.weight) > this.ctx.maxStates) throw new TooManyStates()
    this.kind.push(kind); this.out.push(out); this.out2.push(out2); this.arg.push(arg)
    return this.kind.length - 1
  }

  node(node: Node, next: number): number {
    this.ctx.work += 1
    switch (node.type) {
      case 'empty': return next
      case 'char': case 'set': return this.add(CHAR, next, -1, this.ctx.pred(node))
      case 'seq': {
        let at = next
        for (let k = node.items.length - 1; k >= 0; k -= 1) at = this.node(node.items[k]!, at)
        return at
      }
      case 'alt': {
        const entries = node.items.map((item) => this.node(item, next))
        let at = entries[entries.length - 1]!
        for (let k = entries.length - 2; k >= 0; k -= 1) at = this.add(SPLIT, entries[k]!, at, 0)
        return at
      }
      case 'assert': return this.add(ASSERT, next, -1, ASSERT_IDS[node.kind])
      case 'look': return this.add(ASSERT, next, -1, LOOK_BASE + this.ctx.look(node))
      case 'repeat': return this.repeat(node, next)
    }
  }

  private repeat(node: Extract<Node, { type: 'repeat' }>, next: number): number {
    const width = this.ctx.minWidth(node.body)
    const length = this.ctx.maxLength
    const cap = (width >= 1 ? Math.floor(length / width) : length) + 1
    const fits = width >= 1 ? Math.floor(length / width) : length + 1
    const min = Math.min(node.min, cap)
    // Below `fits` (<= cap) a finite count needs no clamp; at or above it, it is no bound at all.
    const max = node.max >= fits ? Infinity : node.max
    let at: number
    if (max === Infinity) {
      const loop = this.add(SPLIT, -1, next, 0)
      this.out[loop] = this.node(node.body, loop)
      at = loop
    } else {
      at = next
      for (let k = max - min; k > 0; k -= 1) at = this.add(SPLIT, this.node(node.body, at), next, 0)
    }
    for (let k = 0; k < min; k += 1) at = this.node(node.body, at)
    return at
  }

  program(body: Node): Program {
    const match = this.add(MATCH, -1, -1, 0)
    const entry = this.node(body, match)
    const start = this.add(SPLIT, entry, -1, 0)
    const size = this.kind.length
    const program: Program = {
      size,
      kind: Uint8Array.from(this.kind),
      out: Int32Array.from(this.out),
      out2: Int32Array.from(this.out2),
      arg: Int32Array.from(this.arg),
      start,
      chars: Int32Array.from(this.kind.flatMap((kind, n) => (kind === CHAR && !this.ctx.preds[this.arg[n]!]!.never ? [n] : []))),
      predStart: new Int32Array(size + 1),
      predList: new Int32Array(0),
    }
    const { out, out2, predStart } = program
    for (let n = 0; n < size; n += 1) {
      if (out[n]! >= 0) predStart[out[n]! + 1] += 1
      if (out2[n]! >= 0) predStart[out2[n]! + 1] += 1
    }
    for (let n = 0; n < size; n += 1) predStart[n + 1] += predStart[n]!
    const fill = predStart.slice(0, size)
    program.predList = new Int32Array(predStart[size]!)
    const link = (to: number, from: number): void => {
      program.predList[fill[to]!] = from
      fill[to] = fill[to]! + 1
    }
    for (let n = 0; n < size; n += 1) {
      if (out[n]! >= 0) link(out[n]!, n)
      if (out2[n]! >= 0) link(out2[n]!, n)
    }
    return program
  }
}

class Context {
  used = 0
  cost = 0
  work = 0
  private readonly widths = new Map<Node, number>()
  readonly preds: Pred[] = []
  readonly looks: Look[] = []
  private readonly predIds = new Map<string, number>()
  /** Per parsed node: every copy a repeat makes shares its body's nodes, so the key is built once. */
  private readonly predOfNode = new Map<Node, number>()
  private readonly lookIds = new Map<Node, number>()

  constructor(readonly maxLength: number, readonly maxStates: number) {}

  minWidth(node: Node): number {
    return minWidthOf(node, this.widths)
  }

  pred(node: Extract<Node, { type: 'char' | 'set' }>): number {
    const known = this.predOfNode.get(node)
    if (known !== undefined) return known
    const key = node.type === 'char' ? `c${node.ci ? 1 : 0}:${node.code}` : `s${node.ci ? 1 : 0}${node.negate ? 1 : 0}:${node.ranges.join(',')}`
    let id = this.predIds.get(key)
    if (id === undefined) {
      id = this.preds.push(makePred(node)) - 1
      this.predIds.set(key, id)
    }
    this.predOfNode.set(node, id)
    return id
  }

  /** A lookaround's id: one program per lookaround, however many copies of it a repeat makes. */
  look(node: Extract<Node, { type: 'look' }>): number {
    let id = this.lookIds.get(node)
    if (id === undefined) {
      const program = new Builder(this, 2).program(node.body)
      id = this.looks.push({ program, behind: node.behind, negate: node.negate }) - 1
      this.lookIds.set(node, id)
    }
    return id
  }
}

export function compilePattern(parsed: Node, maxLength: number, maxStates: number): CompiledPattern {
  const tree = simplify(parsed)
  const ctx = new Context(maxLength, maxStates)
  const main = new Builder(ctx, 1).program(tree)
  const asciiTable = new Uint8Array(ctx.preds.length * 128)
  ctx.preds.forEach((pred, p) => asciiTable.set(pred.ascii, p * 128))
  return { main, looks: ctx.looks, preds: ctx.preds, asciiTable, states: ctx.used, work: ctx.work, anchored: anchoredAtStart(tree) }
}
