/**
 * Finds the wall-clock gates in Swift test source: an assertion that puts an upper bound
 * on a measured duration, or on the clock itself against a deadline. A shared CI runner
 * stalls now and then, and a gate that judges one timed pass (or each pass on its own, or
 * the worst of several) charges that stall to the code under test (run 41505408126: a
 * 1.37 s stall in one 0.5 s drain failed FirstPaintFreezeTests). Such a gate is judged
 * through PerfGate (ios-native/WalnutTests/PerfGate.swift): the median of its passes, or
 * the worst step but one of one long loop.
 *
 * It reads the source with patterns, it does not parse or run it, so it is best effort: it
 * follows only what a test writes on the page, in the shapes listed here. A duration comes
 * from a timing expression: the `ms { }` helper, PerfGate.ms or PerfGate.passes, a
 * `uptimeNanoseconds` or CFAbsoluteTimeGetCurrent difference, a clock's `measure`, or a
 * `timeIntervalSince` / `timeIntervalSinceNow` / `distance(to:)` / subtraction between two
 * readings of the machine clock (`Date()`, `DispatchTime.now()`, a ContinuousClock's `now`,
 * or a name holding one). A date worked out from a reading (`now.addingTimeInterval(3600)`,
 * a backoff, a `createdAt`) is no reading, so its distance from the clock is no timing.
 * From there a duration flows through assignments (to a property too, `self.x` or a bare
 * name the class declares, across the class's functions), `+=`, `append`, a `for` loop over
 * durations (a tuple loop marks only its duration positions: the element of `enumerated()`,
 * each sequence of a `zip`), the parameters of a closure called on durations (`forEach`,
 * `map`, `allSatisfy`, `filter`, `contains`, ...), calls to the class's own functions that
 * time something and return a number, and the verdicts a duration decides
 * (`if ms >= budget { over.append(…) }`). PerfGate.median, PerfGate.worstButOne and
 * PerfGate.summary end the flow. A count (cells, frames, reads, the `.count` of a list of
 * durations, filtered or not, an index) is never a duration, however it is named, so
 * "fewer than two slow passes" is a vote and passes.
 *
 * The bounds it reads: XCTAssertLessThan(OrEqual), XCTAssertGreaterThan(OrEqual) with the
 * duration second, XCTAssert / XCTAssertTrue / XCTAssertFalse on a comparison or a verdict,
 * XCTAssertNil / XCTAssertNotNil on a search over durations (`passes.first { $0 > 100 }`),
 * an XCTFail inside `if <duration> > budget { }` or `guard <duration> < budget else { }`, and
 * a class helper whose own assertion bounds a parameter (`assertFast(e)`). The clock read
 * against a deadline inside a `while` or `repeat` loop is a wait's timeout, not a gate.
 *
 * What it cannot see: a timing helper in another file or type (a function there that
 * returns a struct of timings, an extension method), a duration passed in from outside the
 * class, a test's own clock type it does not know, an XCTFail in the `else` of an `if`, a
 * condition or loop header split over lines, a `$1` of a tuple's elements, and an
 * assertion helper in another file. A gate written that way is not caught here, so a new
 * timing helper belongs in PerfGate.
 */

export type WallClockGate = { method: string; line: number; assert: string }

/** Blank comments and the contents of string literals, keeping offsets and newlines. */
export function stripSwift(src: string): string {
  const out = src.split('')
  let i = 0
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i)
      const stop = end < 0 ? src.length : end
      blank(i, stop); i = stop; continue
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      blank(i, stop); i = stop; continue
    }
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3)
      const stop = end < 0 ? src.length : end + 3
      blank(i + 3, stop - 3); i = stop; continue
    }
    if (src[i] === '#' && src[i + 1] === '"') { // raw string #"..."#
      const end = src.indexOf('"#', i + 2)
      const stop = end < 0 ? src.length : end + 2
      blank(i + 2, stop - 2); i = stop; continue
    }
    if (src[i] === '"') {
      // An ordinary literal; an interpolation \( ... ) may hold parentheses and quotes.
      let k = i + 1
      let depth = 0
      while (k < src.length) {
        const c = src[k]
        if (depth === 0) {
          if (c === '\\' && src[k + 1] === '(') { depth = 1; k += 2; continue }
          if (c === '\\') { k += 2; continue }
          if (c === '"' || c === '\n') break
        } else if (c === '(') depth++
        else if (c === ')') depth--
        else if (c === '"') { // a nested literal inside the interpolation
          k++
          while (k < src.length && src[k] !== '"' && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1
        }
        k++
      }
      blank(i + 1, k); i = k + 1; continue
    }
    i++
  }
  return out.join('')
}

/** The index just past the bracket that closes the one at `open`. */
function closing(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const stack: string[] = []
  for (let k = open; k < src.length; k++) {
    const c = src[k]!
    if (pairs[c]) stack.push(pairs[c]!)
    else if (c === stack[stack.length - 1]) { stack.pop(); if (stack.length === 0) return k + 1 }
  }
  return src.length
}

/** Split an argument list (without its parentheses) at its top-level commas. */
function splitArgs(s: string): string[] {
  const args: string[] = []
  let depth = 0
  let from = 0
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { args.push(s.slice(from, k)); from = k + 1 }
  }
  args.push(s.slice(from))
  return args.map((a) => a.trim())
}

/** `text` with every PerfGate.median / worstButOne / summary call cut out. */
function withoutJudgedCalls(text: string): string {
  const JUDGED = /PerfGate\s*\.\s*(?:median|worstButOne|summary)\s*\(/g
  let out = text
  for (let m = JUDGED.exec(out); m; m = JUDGED.exec(out)) {
    const open = m.index + m[0].length - 1
    out = out.slice(0, m.index) + 'judged' + out.slice(closing(out, open))
    JUDGED.lastIndex = m.index + 'judged'.length
  }
  return out
}

// Always a duration: the `ms { }` helper, PerfGate's timed passes, a nanosecond or
// CFAbsoluteTime difference, a clock's measure.
const TIMED = /\bms\s*\{|\bms\s*\(\s*\{|PerfGate\s*\.\s*(?:ms|passes)\b|uptimeNanoseconds|CFAbsoluteTimeGetCurrent\s*\(\s*\)\s*-|\.measure\s*\{/
// A reading of the machine's own clock (never the app's AppClock or a test's fake clock).
const NOW_SRC = String.raw`\bDate\s*\(\s*\)|\bDate\.now\b|DispatchTime\.now\s*\(\s*\)|CFAbsoluteTimeGetCurrent\s*\(\s*\)|\.systemUptime\b|CACurrentMediaTime\s*\(\s*\)|(?:Continuous|Suspending)Clock\s*(?:\(\s*\))?\s*\.now\b`
const NOW = new RegExp(NOW_SRC)

type ClockNames = { readings: string[]; clocks: string[] }

/** Names in `text` that hold a reading of the machine clock, and names that hold such a clock. */
function clockNames(text: string): ClockNames {
  // A statement ends at its line, a `;`, or the brace of a one-line body.
  const clocks = [...text.matchAll(/\b(?:let|var)\s+(\w+)\s*=\s*(?:Continuous|Suspending)Clock\s*\(\s*\)\s*(?=[;}]|$)/gm)].map((m) => m[1]!)
  const names: ClockNames = { readings: [], clocks }
  for (const m of text.matchAll(/\b(?:let|var)\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*([^\n;}]+?)\s*(?=[;}]|$)/gm)) {
    if (isReading(m[2]!.trim(), names)) names.readings.push(m[1]!)
  }
  return names
}

/** Is `expr` exactly a reading of the machine clock: a clock call, `clock.now`, or a name holding one? */
function isReading(expr: string, names: ClockNames): boolean {
  const e = expr.trim().replace(/^\(\s*(.*?)\s*\)$/, '$1')
  if (new RegExp(`^(?:${NOW_SRC})$`).test(e)) return true
  if (names.clocks.some((c) => new RegExp(`^${c}\\s*\\.\\s*now$`).test(e))) return true
  return names.readings.includes(e)
}

/** The postfix expression ending just before `end` (`a.b(c)[d]`), walking back over brackets. */
function operandBefore(text: string, end: number): string {
  let k = end
  while (k > 0 && /\s/.test(text[k - 1]!)) k--
  const stop = k
  const open: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  while (k > 0) {
    const c = text[k - 1]!
    if (open[c]) {
      let depth = 0
      let j = k - 1
      for (; j >= 0; j--) {
        if (text[j] === c) depth++
        else if (text[j] === open[c]) { depth--; if (depth === 0) break }
      }
      k = Math.max(j, 0)
      // A trailing closure (`passes.filter { … }`) belongs to the call before its space.
      if (c === '}') {
        let w = k
        while (w > 0 && /[ \t]/.test(text[w - 1]!)) w--
        if (w > 0 && /[\w)\]]/.test(text[w - 1]!)) k = w
      }
      continue
    }
    if (/[\w.$]/.test(c)) { k--; continue }
    break
  }
  return text.slice(k, stop)
}

/** The postfix expression starting at `from`. */
function operandAfter(text: string, from: number): string {
  let k = from
  while (k < text.length && /\s/.test(text[k]!)) k++
  const start = k
  while (k < text.length) {
    const c = text[k]!
    if (c === '(' || c === '[') { k = closing(text, k); continue }
    if (/[\w.$]/.test(c)) { k++; continue }
    break
  }
  return text.slice(start, k)
}

/** Is `expr` a timing expression: a measure, or a difference between two clock readings? */
function timed(expr: string, names: ClockNames): boolean {
  if (TIMED.test(expr)) return true
  for (const m of expr.matchAll(/\.\s*timeIntervalSince(Now\b|\s*\()/g)) {
    const a = operandBefore(expr, m.index!)
    if (!isReading(a, names)) continue
    if (m[1] === 'Now') return true
    const open = m.index! + m[0].length - 1
    if (isReading(expr.slice(open + 1, closing(expr, open) - 1), names)) return true
  }
  for (const m of expr.matchAll(/\.\s*distance\s*\(\s*to\s*:/g)) {
    if (!isReading(operandBefore(expr, m.index!), names)) continue
    const open = expr.indexOf('(', m.index!)
    const arg = expr.slice(open + 1, closing(expr, open) - 1).replace(/^\s*to\s*:/, '')
    if (isReading(arg, names)) return true
  }
  for (const m of expr.matchAll(/\s-\s/g)) {
    if (isReading(operandBefore(expr, m.index!), names) && isReading(operandAfter(expr, m.index! + m[0].length), names)) return true
  }
  return false
}

/** The functions of `src` that time something and return a value. */
function timingFunctions(src: string): Set<string> {
  const names = new Set<string>()
  const FUNC = /\bfunc\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g
  for (let m = FUNC.exec(src); m; m = FUNC.exec(src)) {
    const paramsEnd = closing(src, m.index + m[0].length - 1)
    const brace = src.indexOf('{', paramsEnd)
    if (brace < 0) continue
    const signature = src.slice(paramsEnd, brace)
    // Only a function that returns a time: a number, a Duration, or a tuple or array of them.
    if (!/->\s*[([]*[^{]*\b(?:Double|TimeInterval|CFTimeInterval|Duration|Float|UInt64)\b/.test(signature)) continue
    const fnBody = src.slice(brace, closing(src, brace))
    const fnNames = clockNames(fnBody)
    if (fnBody.split('\n').some((line) => timed(line, fnNames))) names.add(m[1]!)
  }
  names.delete('ms') // the helper itself is a source already
  return names
}

/** The functions of a class body (`func …`), their parameters and bodies; nested ones belong to their function. */
function methods(src: string): { name: string; params: string; start: number; end: number }[] {
  const out: { name: string; params: string; start: number; end: number }[] = []
  const FUNC = /\bfunc\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g
  for (let m = FUNC.exec(src); m; m = FUNC.exec(src)) {
    const open = m.index + m[0].length - 1
    const paramsEnd = closing(src, open)
    const brace = src.indexOf('{', paramsEnd)
    if (brace < 0) continue
    const end = closing(src, brace)
    out.push({ name: m[1]!, params: src.slice(open + 1, paramsEnd - 1), start: brace, end })
    FUNC.lastIndex = end
  }
  return out
}

/** `expr` with every count of a list cut out: `x.count`, `x.filter { … }.count`, `x.indices`. */
function countsOut(expr: string): string {
  let out = expr
  const COUNT = /\.\s*(?:count|indices|startIndex|endIndex)\b/g
  for (let m = COUNT.exec(out); m; m = COUNT.exec(out)) {
    const operand = operandBefore(out, m.index)
    const from = operand ? out.lastIndexOf(operand, m.index) : m.index
    out = out.slice(0, from) + 'n' + out.slice(m.index + m[0].length)
    COUNT.lastIndex = from + 1
  }
  return out
}

/** Which positions of a tuple sequence hold durations: `x.enumerated()` (offset, element), `zip(a, b)`. */
function tupleShape(seq: string, isDuration: (e: string) => boolean): boolean[] | null {
  const s = seq.trim()
  const en = s.match(/^([\s\S]*)\.\s*enumerated\s*\(\s*\)$/)
  if (en) return [false, isDuration(en[1]!)]
  if (/^zip\s*\(/.test(s)) {
    const open = s.indexOf('(')
    if (closing(s, open) === s.length) return splitArgs(s.slice(open + 1, -1)).map((a) => isDuration(a))
  }
  return null
}

// A name taking a value: `let x`, `let (a, b)`, `x =`, `self.x =`, `x +=`, `x.append(`.
const ASSIGN = /(?:\b(?:let|var)\s+(?:\(([^)]*)\)|(\w+))(?:\s*:\s*[^=\n]+)?|(?<![\w.])(?:self\s*\.\s*)?(\w+)(?:\s*\[[^\]]*\])?\s*(?:\+=|-=|=(?!=))|(?<![\w.])(?:self\s*\.\s*)?(\w+)\s*\.\s*append(?:\s*\(\s*contentsOf\s*:)?)/g
// A closure called on a value, with its parameters if it names them.
const CLOSURE_CALL = /\.\s*(\w+)\s*(?:\(\s*(?:where|by)\s*:\s*)?\{(\s*(?:\(\s*)?((?:\w+\s*,\s*)*\w+)\s*\)?\s*in\b)?/g
const ELEMENT_CALLS = new Set(['forEach', 'map', 'compactMap', 'flatMap', 'allSatisfy', 'filter', 'contains', 'first', 'last', 'firstIndex', 'drop', 'prefix', 'sorted', 'min', 'max', 'reduce'])
// A `for` loop: its variable or tuple of variables, and the sequence.
const FOR_LOOP = /\bfor\s+(?:case\s+)?(?:let\s+|var\s+)?(?:\(([^()]*)\)|(\w+))\s+in\s+([^{\n]+)\{/g

type Closure = { start: number; end: number; durs: boolean; shape: boolean[] | null }
type Flow = { durations: Set<string>; isDuration: (expr: string, at?: number) => boolean }

/** The names in `text` that hold durations, to a fixed point, seeded with `seed`. */
function durationFlow(text: string, names: ClockNames, callsTimedFn: (t: string) => boolean, seed: Iterable<string>): Flow {
  const durations = new Set<string>(seed)
  // A name holding one tuple of a tuple sequence, with its duration positions.
  const tuples = new Map<string, boolean[]>()
  const closures: Closure[] = []
  const has = (e: string, d: string) => new RegExp(`(?<![\\w.])(?:self\\s*\\.\\s*)?${d}\\b`).test(e)
  const innermost = (at: number) => closures.filter((c) => c.start <= at && at < c.end).sort((a, b) => b.start - a.start)[0]
  const position = (member: string) => member === 'offset' ? 0 : member === 'element' ? 1 : Number(member)
  const isDuration = (expr: string, at = -1): boolean => {
    // A list's length is a count, never a time.
    let e = countsOut(withoutJudgedCalls(expr))
    if (timed(e, names) || callsTimedFn(e)) return true
    // A tuple's members: only its duration positions are durations (`$0.element`, `pair.1`).
    let member = false
    const members = (name: string, shape: boolean[]) => {
      e = e.replace(new RegExp(`${name}\\s*\\.\\s*(offset|element|\\d+)\\b`, 'g'), (_m, p: string) => { if (shape[position(p)]) member = true; return 'n' })
    }
    const around = at >= 0 ? innermost(at) : undefined
    if (around?.shape) members('\\$0', around.shape)
    for (const [t, shape] of tuples) members(`(?<![\\w.])${t}`, shape)
    if (member) return true
    if (/\$0\b/.test(e) && around?.durs) return true
    return [...durations].some((d) => has(e, d))
  }
  let grew = true
  while (grew) {
    grew = false
    const add = (t: string | undefined) => { if (t && t !== '_' && !durations.has(t)) { durations.add(t); grew = true } }
    const addTuple = (t: string, shape: boolean[]) => { if (t !== '_' && !tuples.has(t)) { tuples.set(t, shape); grew = true } }
    // A tuple of names over a tuple sequence: each its own position; one name holds the tuple.
    const bind = (targets: string[], shape: boolean[] | null, whole: boolean) => {
      if (shape && targets.length === shape.length) targets.forEach((t, i) => { if (shape[i]) add(t) })
      else if (shape && targets.length === 1) { if (shape.some(Boolean)) addTuple(targets[0]!, shape) }
      else if (whole) for (const t of targets) add(t)
    }
    for (let m = ASSIGN.exec(text); m; m = ASSIGN.exec(text)) {
      const targets = m[1] ? m[1].split(',').map((t) => t.replace(/\b(?:let|var)\b/g, '').trim()) : [m[2] ?? m[3] ?? m[4]!]
      let rhs: string
      if (m[4]) {
        const open = text.indexOf('(', m.index + m[0].length - 1)
        rhs = open < 0 ? '' : text.slice(open, closing(text, open))
      } else {
        const after = text.slice(m.index + m[0].length).replace(/^\s*=?/, '')
        // The right-hand side runs to the end of its line, or of the closure it opens.
        const brace = after.search(/[{\n]/)
        rhs = brace >= 0 && after[brace] === '{' ? after.slice(0, closing(after, brace)) : after.split('\n')[0]!
      }
      if (isDuration(rhs, m.index)) for (const t of targets) add(t)
    }
    ASSIGN.lastIndex = 0
    // A loop over durations: its variable is one; a tuple loop marks its duration positions.
    for (const m of text.matchAll(FOR_LOOP)) {
      const seq = m[3]!.replace(/\s+where\b[\s\S]*$/, '')
      const targets = m[1] ? m[1].split(',').map((t) => t.trim()) : [m[2]!]
      const shape = tupleShape(seq, (e) => isDuration(e, m.index))
      bind(targets, shape, !shape && isDuration(seq, m.index))
    }
    // A closure called on durations: its parameters (or `$0`) are.
    closures.length = 0
    for (const m of text.matchAll(CLOSURE_CALL)) {
      const dot = m.index!
      const open = dot + m[0].length - (m[2]?.length ?? 0) - 1
      const end = closing(text, open)
      const receiver = operandBefore(text, dot)
      const element = ELEMENT_CALLS.has(m[1]!) && receiver !== ''
      const shape = element ? tupleShape(receiver, (e) => isDuration(e, dot)) : null
      const durs = element && (shape ? shape.some(Boolean) : isDuration(receiver, dot))
      closures.push({ start: open, end, durs, shape })
      if (durs && m[3]) bind(m[3].split(',').map((p) => p.trim()), shape, true)
    }
    // A verdict a duration decides (`if ms >= budget { over.append(…) }`) carries it too.
    for (const m of text.matchAll(/\b(?:if|guard)\s+([^{\n]*)\{/g)) {
      if (!isDuration(m[1]!, m.index)) continue
      const open = m.index! + m[0].length - 1
      const block = text.slice(open, closing(text, open))
      for (const a of block.matchAll(ASSIGN)) add(a[2] ?? a[3] ?? a[4])
    }
  }
  return { durations, isDuration }
}

type Bound = 'duration' | 'clock' | null

/** Every wall-clock gate in `body` (one class's source) that PerfGate does not judge. */
export function wallClockGates(body: string): WallClockGate[] {
  // A chained call on the next line (`Date()` newline `.timeIntervalSince(t0)`) is one
  // expression: join it, keeping every offset.
  const src = stripSwift(body).replace(/\n(?=[ \t]*\.\w)/g, ' ')
  const timedFns = timingFunctions(src)
  const callsTimedFn = (text: string) => [...timedFns].some((f) => new RegExp(`\\b${f}\\s*\\(`).test(text))
  const fns = methods(src)
  // The class's own stored properties: what is declared outside every function.
  let outside = src
  for (const fn of fns) outside = outside.slice(0, fn.start) + ' '.repeat(fn.end - fn.start) + outside.slice(fn.end)
  const declared = new Set([...outside.matchAll(/\b(?:let|var)\s+(\w+)/g)].map((m) => m[1]!))
  // Properties holding a duration (`self.x = ms { }`, or a bare `x = ms { }` on a declared
  // property, in any function of the class).
  const props = new Set<string>()
  for (const fn of fns) {
    const text = src.slice(fn.start, fn.end)
    const flow = durationFlow(text, clockNames(text), callsTimedFn, [])
    const local = new Set([...text.matchAll(/\b(?:let|var)\s+(\w+)/g)].map((m) => m[1]!))
    for (const m of text.matchAll(/(?<![\w.])(self\s*\.\s*)?(\w+)\s*(?:\+=|=(?!=)|\.\s*append)/g)) {
      const name = m[2]!
      if (flow.durations.has(name) && (m[1] || (declared.has(name) && !local.has(name)))) props.add(name)
    }
  }

  // The gates of one function, with `seed` holding durations; `helpers` bound parameters.
  type Helper = { label: string; index: number }[]
  const scan = (fn: (typeof fns)[number], seed: Iterable<string>, helpers: Map<string, Helper>): number[] => {
    const text = src.slice(fn.start, fn.end)
    const names = clockNames(text)
    const flow = durationFlow(text, names, callsTimedFn, [...props, ...seed])
    // The clock against a deadline inside a `while` or `repeat` loop is a wait's timeout.
    const polls = [...text.matchAll(/\b(?:while\b[^{\n]*|repeat\s*)\{/g)].map((m) => {
      const open = m.index! + m[0].length - 1
      return { start: open, end: closing(text, open) }
    })
    const inPoll = (at: number) => polls.some((p) => p.start <= at && at < p.end)
    const bound = (side: string | undefined, at: number): Bound =>
      side === undefined ? null : flow.isDuration(side, at) ? 'duration' : isReading(side, names) ? 'clock' : null
    const gates = (b: Bound, at: number) => b === 'duration' || (b === 'clock' && !inPoll(at))
    // Each comparison of a condition: `a < b` bounds a, and so does `b > a`; a false
    // condition (XCTAssertFalse, the `if` of an XCTFail) turns them round.
    const condition = (cond: string, holds: boolean, at: number, verdict: boolean): boolean => {
      const parts = splitArgs(withoutJudgedCalls(cond)).flatMap((c) => c.split(/&&|\|\|/))
      const compares = parts.some((part) => /[<>]/.test(part.replace(/->/g, '')))
      if (!compares) return verdict && flow.isDuration(cond, at)
      return parts.some((part) => {
        const lt = part.match(/^(.*?)<=?(.*)$/)
        const gt = part.match(/^(.*?)>=?(.*)$/)
        const side = holds ? (lt ? lt[1] : gt ? gt[2] : undefined) : (gt ? gt[1] : lt ? lt[2] : undefined)
        return gates(bound(side, at), at)
      })
    }
    const out: number[] = []
    const ASSERT = /\bXCTAssert(LessThan|LessThanOrEqual|GreaterThan|GreaterThanOrEqual|True|False|Nil|NotNil|)\s*\(/g
    for (let m = ASSERT.exec(text); m; m = ASSERT.exec(text)) {
      const open = m.index + m[0].length - 1
      const args = splitArgs(text.slice(open + 1, closing(text, open) - 1))
      const kind = m[1]
      let hit = false
      if (kind === 'LessThan' || kind === 'LessThanOrEqual') hit = gates(bound(args[0], m.index), m.index)
      else if (kind === 'GreaterThan' || kind === 'GreaterThanOrEqual') hit = gates(bound(args[1], m.index), m.index)
      // Nil / NotNil judge a search (`passes.first { $0 > 100 }`): no element, or some, holds.
      else if (kind === 'Nil' || kind === 'NotNil') hit = /[<>]/.test(args[0] ?? '') && condition(args[0] ?? '', kind === 'NotNil', m.index, false)
      else hit = condition(args[0] ?? '', kind !== 'False', m.index, true)
      if (hit) out.push(m.index)
    }
    // An XCTFail an upper bound decides: `if e > budget { XCTFail }`, `guard e < budget else { XCTFail }`.
    for (const m of text.matchAll(/\b(if|guard)\s+([^{\n]*)\{/g)) {
      const open = m.index! + m[0].length - 1
      if (!/\bXCTFail\s*\(/.test(text.slice(open, closing(text, open)))) continue
      const isGuard = m[1] === 'guard'
      const cond = isGuard ? m[2]!.replace(/\belse\s*$/, '') : m[2]!
      if (condition(cond, isGuard, m.index!, false)) out.push(m.index!)
    }
    // A call to a class helper that bounds one of its parameters, with a duration there.
    for (const [name, bounded] of helpers) {
      for (const m of text.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g'))) {
        if (/\bfunc\s+$/.test(text.slice(0, m.index))) continue
        const open = m.index! + m[0].length - 1
        const args = splitArgs(text.slice(open + 1, closing(text, open) - 1))
        const hit = bounded.some(({ label, index }) => {
          const arg = label === '_' ? args[index] : args.find((a) => new RegExp(`^${label}\\s*:`).test(a))?.replace(/^\w+\s*:/, '')
          return arg !== undefined && flow.isDuration(arg, m.index!)
        })
        if (hit) out.push(m.index!)
      }
    }
    return out
  }

  // Assertion helpers: a function whose own assertion bounds a parameter given a duration.
  const helpers = new Map<string, Helper>()
  for (const fn of fns) {
    if (!fn.params.trim()) continue
    const without = scan(fn, [], new Map()).length
    const bounded: Helper = []
    splitArgs(fn.params).forEach((p, index) => {
      const pm = p.match(/^(\w+)(?:\s+(\w+))?\s*:/)
      if (!pm) return
      if (scan(fn, [pm[2] ?? pm[1]!], new Map()).length > without) bounded.push({ label: pm[1]!, index })
    })
    if (bounded.length) helpers.set(fn.name, bounded)
  }

  const gates: WallClockGate[] = []
  for (const fn of fns) {
    for (const index of scan(fn, [], helpers)) {
      const at = fn.start + index
      gates.push({ method: fn.name, line: body.slice(0, at).split('\n').length, assert: body.slice(at, body.indexOf('\n', at)).trim() })
    }
  }
  return gates
}
