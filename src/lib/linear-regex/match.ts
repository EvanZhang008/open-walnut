/**
 * Running the programs as a Pike VM: every live NFA state advances one text position at a time and
 * each state is visited at most once per position, so a run costs O(text length x states).
 *
 * Without back-references a lookaround is a pure position predicate, so each is computed once over
 * positions 0..T before the program that asks it, innermost first. A lookbehind body runs forward
 * from every position and marks where it ends; a lookahead body runs backward over its predecessor
 * graph from every position and marks where it starts.
 *
 * A cut text (`truncated`: the real text goes on) gets two answers per assertion: `lo`, true only
 * where it surely holds in the real text, and `hi`, true wherever it may. The pattern runs on `lo`,
 * so a cut text may miss a match but never gains one. `$` never holds at the cut, `\b` and `\B`
 * there read `next`, and a lookahead body that reaches the cut in a state waiting for a character
 * `next` can be (any character, without `next`) may match (`hi`) but not surely (`lo`). A negative lookaround swaps them: its `lo` is
 * "the body cannot match" (!body.hi), its `hi` is "the body does not surely match" (!body.lo).
 */
import { caseTable, type CaseTable } from './case-fold.js'
import { contains, isLineTerminator, isWordCode } from './charset.js'
import { ASSERT, CHAR, LOOK_BASE, SPLIT, type CompiledPattern, type Look, type Pred, type Program } from './compile.js'

// The subject of the run in progress, and scratch every run reuses (a run never starts another).
let text = ''
let T = 0
let truncated = false
let nextCode = -1
let loArrays: Uint8Array[] = []
let hiArrays: Uint8Array[] = []
let table: CaseTable | null = null

let mark = new Int32Array(64)
let markNext = new Int32Array(64)
let listA = new Int32Array(64)
let listB = new Int32Array(64)
let stack = new Int32Array(196)
let generation = 0
let matchHit = false

// Non-ASCII code units: each text position's dense id among the text's distinct ones, and every
// pred's answer for each id, filled on first ask (0 unknown, 1 no, 2 yes). A case-insensitive class
// otherwise walks its case class per live state per position: a 90-letter class near the state cap
// took 51 ms on 300 Greek letters against 12 ms on ASCII; with the cache, 14 ms (2026-11-04).
let predList: Pred[] = []
let denseAt = new Int32Array(64)
let answers = new Uint8Array(64)
let answerStride = 0

function indexText(subject: string, predCount: number): void {
  if (denseAt.length < subject.length) denseAt = new Int32Array(Math.max(subject.length, denseAt.length * 2))
  let ids: Map<number, number> | null = null
  for (let i = 0; i < subject.length; i += 1) {
    const ch = subject.charCodeAt(i)
    if (ch < 128) continue
    ids ??= new Map()
    let id = ids.get(ch)
    if (id === undefined) { id = ids.size; ids.set(ch, id) }
    denseAt[i] = id
  }
  answerStride = ids?.size ?? 0
  const size = predCount * answerStride
  if (answers.length < size) answers = new Uint8Array(Math.max(size, answers.length * 2))
  else answers.fill(0, 0, size)
}

/** Does pred `p` take the non-ASCII code unit `ch` at text position `pos`? */
function hitAt(p: number, pos: number, ch: number): boolean {
  const slot = p * answerStride + denseAt[pos]!
  const known = answers[slot]
  if (known !== 0) return known === 2
  const yes = matches(predList[p]!, ch)
  answers[slot] = yes ? 2 : 1
  return yes
}

function room(size: number): void {
  if (mark.length < size) {
    const length = Math.max(size, mark.length * 2)
    mark = new Int32Array(length)
    markNext = new Int32Array(length)
    listA = new Int32Array(length)
    listB = new Int32Array(length)
  }
  // A closure's stack holds its seeds (at most one per node) plus one push per edge (two per node).
  if (stack.length < 3 * size + 4) stack = new Int32Array(3 * size + 4)
}

function nextGeneration(): number {
  if (generation >= 0x3fffffff) {
    mark.fill(0)
    markNext.fill(0)
    generation = 0
  }
  return (generation += 1)
}

/** 1 word character, 0 not, -1 unknown (the cut, with no `next`). */
function wordAt(pos: number): number {
  if (pos < T) return isWordCode(text.charCodeAt(pos)) ? 1 : 0
  if (!truncated) return 0
  return nextCode < 0 ? -1 : isWordCode(nextCode) ? 1 : 0
}

function holds(id: number, pos: number, hi: boolean): boolean {
  switch (id) {
    case 0: return pos === 0
    case 1: return pos === 0 || isLineTerminator(text.charCodeAt(pos - 1))
    case 2: return pos === T && !truncated
    case 3:
      if (pos < T) return isLineTerminator(text.charCodeAt(pos))
      if (!truncated) return true
      return nextCode < 0 ? hi : isLineTerminator(nextCode)
    case 4: case 5: {
      const after = wordAt(pos)
      if (after < 0) return hi
      const before = pos > 0 && isWordCode(text.charCodeAt(pos - 1)) ? 1 : 0
      return (before !== after) === (id === 4)
    }
    default: return (hi ? hiArrays : loArrays)[id - LOOK_BASE]![pos] === 1
  }
}

function matches(pred: Pred, ch: number): boolean {
  if (ch < 128) return pred.ascii[ch] === 1
  // No code unit >= 128 folds to one under 128, so ASCII-only literals and sets need no table here.
  if (pred.code >= 0) {
    if (!pred.ci) return ch === pred.code
    return pred.code >= 128 && ((table ??= caseTable()).canon[ch] || ch) === pred.code
  }
  let found = false
  if (!pred.ci) found = contains(pred.ranges, ch)
  else if (!pred.asciiOnly) {
    table ??= caseTable()
    const at = table.classAt[ch]! - 1
    if (at < 0) found = contains(pred.ranges, ch)
    // Under `i`: some member of the class shares this code unit's canonical form.
    else for (let k = table.members[at]!; k > 0 && !found; k -= 1) found = contains(pred.ranges, table.members[at + k]!)
  }
  return found !== pred.negate
}

/**
 * The closure at `pos` of the `sp` nodes already on `stack`, appended to `list` from `count`;
 * returns the new count and sets `matchHit` when it reaches MATCH.
 */
function closeForward(program: Program, sp: number, pos: number, gen: number, list: Int32Array, count: number, hi: boolean): number {
  const { kind, out, out2, arg } = program
  const seen = mark
  const todo = stack
  while (sp > 0) {
    const n = todo[--sp]!
    if (seen[n] === gen) continue
    seen[n] = gen
    const k = kind[n]
    if (k === CHAR) list[count++] = n
    else if (k === SPLIT) {
      const other = out2[n]!
      if (other >= 0) todo[sp++] = other
      todo[sp++] = out[n]!
    } else if (k === ASSERT) {
      if (holds(arg[n]!, pos, hi)) todo[sp++] = out[n]!
    } else matchHit = true
  }
  return count
}

/**
 * Forward from every start position (only 0 when `anchored`). With `ends`, mark each position where
 * the program reaches MATCH; without, answer whether it ever does.
 */
function forward(compiled: CompiledPattern, program: Program, hi: boolean, anchored: boolean, ends: Uint8Array | null): boolean {
  room(program.size)
  const { out, arg, start } = program
  const { asciiTable } = compiled
  const todo = stack
  const subject = text
  const length = T
  let clist = listA
  let nlist = listB
  let count = 0
  let gen = nextGeneration()
  let carried = false
  for (let i = 0; ; i += 1) {
    matchHit = carried
    if (!anchored || i === 0) {
      todo[0] = start
      count = closeForward(program, 1, i, gen, clist, count, hi)
    }
    if (matchHit) {
      if (!ends) return true
      ends[i] = 1
    }
    if (i === length || (count === 0 && anchored)) return false
    const ch = subject.charCodeAt(i)
    let sp = 0
    if (ch < 128) {
      for (let k = 0; k < count; k += 1) {
        const n = clist[k]!
        if (asciiTable[(arg[n]! << 7) | ch] === 1) todo[sp++] = out[n]!
      }
    } else {
      for (let k = 0; k < count; k += 1) {
        const n = clist[k]!
        if (hitAt(arg[n]!, i, ch)) todo[sp++] = out[n]!
      }
    }
    gen = nextGeneration()
    matchHit = false
    count = closeForward(program, sp, i + 1, gen, nlist, 0, hi)
    carried = matchHit
    const swap = clist
    clist = nlist
    nlist = swap
  }
}

/**
 * Backward from every end position: mark each position j from which the program reaches MATCH. A
 * node is live at j when a forward path from it at j reaches MATCH; a CHAR node is live at j when it
 * matches text[j] and its successor is live at j + 1. With `alive`, a CHAR node is also live at the
 * cut when it matches `next` (any CHAR node, without `next`): past the cut the text is unknown.
 */
function backward(compiled: CompiledPattern, program: Program, hi: boolean, alive: boolean, starts: Uint8Array): void {
  room(program.size)
  const { kind, arg, start, predStart, predList, chars } = program
  const { preds, asciiTable } = compiled
  const seen = mark
  const queued = markNext
  const todo = stack
  const subject = text
  let cand = listA
  let nextCand = listB
  let count = 0
  for (let j = T; j >= 0; j -= 1) {
    const gen = nextGeneration()
    let sp = 0
    todo[sp++] = 0 // MATCH is node 0 of every program
    if (j === T) {
      if (alive) {
        const ch = nextCode
        for (let k = 0; k < chars.length; k += 1) {
          const n = chars[k]!
          if (ch < 0 || (ch < 128 ? asciiTable[(arg[n]! << 7) | ch] === 1 : matches(preds[arg[n]!]!, ch))) todo[sp++] = n
        }
      }
    } else {
      const ch = subject.charCodeAt(j)
      for (let k = 0; k < count; k += 1) {
        const n = cand[k]!
        if (ch < 128 ? asciiTable[(arg[n]! << 7) | ch] === 1 : hitAt(arg[n]!, j, ch)) todo[sp++] = n
      }
    }
    let found = 0
    let reached = false
    while (sp > 0) {
      const n = todo[--sp]!
      if (seen[n] === gen) continue
      seen[n] = gen
      if (n === start) reached = true
      for (let e = predStart[n]!, end = predStart[n + 1]!; e < end; e += 1) {
        const p = predList[e]!
        const k = kind[p]
        if (k === CHAR) {
          if (queued[p] !== gen) { queued[p] = gen; nextCand[found++] = p }
        } else if (k === SPLIT || holds(arg[p]!, j, hi)) {
          todo[sp++] = p
        }
      }
    }
    if (reached) starts[j] = 1
    const swap = cand
    cand = nextCand
    nextCand = swap
    count = found
  }
}

function bodyAnswers(compiled: CompiledPattern, look: Look, hi: boolean): Uint8Array {
  const answers = new Uint8Array(T + 1)
  if (look.behind) forward(compiled, look.program, hi, false, answers)
  else backward(compiled, look.program, hi, hi && truncated, answers)
  return answers
}

function negated(answers: Uint8Array): Uint8Array {
  const out = new Uint8Array(answers.length)
  for (let i = 0; i < answers.length; i += 1) out[i] = answers[i] ? 0 : 1
  return out
}

/** Does the pattern match somewhere in `subject` (a cut text when `isTruncated`)? */
export function runPattern(compiled: CompiledPattern, subject: string, isTruncated: boolean, next: number): boolean {
  text = subject
  T = subject.length
  truncated = isTruncated
  nextCode = next
  predList = compiled.preds
  indexText(subject, compiled.preds.length)
  loArrays = []
  hiArrays = []
  for (const look of compiled.looks) {
    const lo = bodyAnswers(compiled, look, false)
    const hi = truncated ? bodyAnswers(compiled, look, true) : lo
    if (!look.negate) {
      loArrays.push(lo)
      hiArrays.push(hi)
    } else {
      const notHi = negated(hi)
      loArrays.push(notHi)
      hiArrays.push(hi === lo ? notHi : negated(lo))
    }
  }
  const found = forward(compiled, compiled.main, false, compiled.anchored, null)
  text = ''
  predList = []
  return found
}
