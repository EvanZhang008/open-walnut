/**
 * Finds, in the phone app's Swift source, everything the app takes away by itself on a clock: a wait
 * (`Task.sleep`, `asyncAfter`, a `Timer`) of a second or more whose work then takes something away,
 * and a date window (a stored "until" deadline, or a check of how long ago something was stamped).
 * Read by tests/web/ios-timed-hide-guard.test.ts, which holds each one to `NoticeTiming`.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The source with comments and string contents blanked, so neither is read as code. */
export const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/"(?:\\.|[^"\\\n])*"/g, '""')

export function swiftFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...swiftFiles(full))
    else if (entry.name.endsWith('.swift')) out.push(full)
  }
  return out
}

/** The index just past the `)` that closes the `(` at `open`. */
function pastParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return i + 1
  }
  return src.length
}

/** The rest of the closure that holds `from`, up to its closing brace. */
function restOfClosure(src: string, from: number): string {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth < 0) return src.slice(from, i)
  }
  return src.slice(from)
}

/** The body of the closure whose `{` is at `open`. */
const closureAt = (src: string, open: number) => restOfClosure(src, open + 1)

const lineOf = (src: string, at: number) => src.slice(0, at).split('\n').length

/** Seconds a length expression asks for, or null when it is not a literal. */
export function literalSeconds(expr: string): number | null {
  const num = (s: string) => Number(s.replace(/_/g, ''))
  const e = expr.trim()
  let m = /^\.?milliseconds\(\s*([\d_.]+)\s*\)$/.exec(e)
  if (m) return num(m[1]) / 1000
  m = /^\.?seconds\(\s*([\d_.]+)\s*\)$/.exec(e)
  if (m) return num(m[1])
  m = /^[\d_.]+$/.exec(e)
  if (m) return num(m[0])
  return null
}

/**
 * Seconds a length expression asks for: a literal, or a name read where the file declares it (the
 * nearest declaration above `at`, else the first in the file, so two types with the same name in one
 * file each read their own). Null when the source does not say (a sum, a call, a name declared
 * elsewhere): such a wait counts as long.
 */
export function lengthSeconds(expr: string, src: string, at = src.length, nanos = false): number | null {
  const e = expr.trim()
  const literal = literalSeconds(e)
  if (literal !== null) return nanos && /^[\d_.]+$/.test(e) ? literal / 1e9 : literal
  const name = /^(?:Self\.|self\.|\w+\.)?(\w+)$/.exec(e)?.[1] ?? /^\.?seconds\(\s*(?:Self\.|self\.)?(\w+)\s*\)$/.exec(e)?.[1]
  if (!name) return null
  const decls = [...src.matchAll(new RegExp(`\\b(?:let|var)\\s+${name}\\s*(?::\\s*[\\w.]+)?\\s*=\\s*([^\\n;]+)`, 'g'))]
  const decl = decls.filter((d) => d.index < at).pop() ?? decls[0]
  if (!decl) return null
  const value = decl[1].trim().replace(/\s*\{$/, '')
  const seconds = literalSeconds(value)
  if (seconds === null) return null
  return nanos && /^[\d_.]+$/.test(value) ? seconds / 1e9 : seconds
}

/** The length a wait asks for, as written: `for:`, `nanoseconds:`, `.now() + x`, a Timer's interval. */
function waitLength(wait: string): { expr: string; nanos: boolean } | null {
  const args = wait.slice(wait.indexOf('(') + 1, -1)
  let m = /^\s*for:\s*([\s\S]+?)\s*(?:,\s*tolerance:[\s\S]*)?$/.exec(args)
  if (m) return { expr: m[1], nanos: false }
  m = /^\s*nanoseconds:\s*([\s\S]+?)\s*$/.exec(args)
  if (m) return { expr: m[1], nanos: true }
  m = /deadline:\s*\.now\(\)\s*\+\s*([^,]+?)\s*(?:,|$)/.exec(args)
  if (m) return { expr: m[1], nanos: false }
  m = /(?:withTimeInterval|timeInterval):\s*([^,]+?)\s*(?:,|$)/.exec(args)
  if (m) return { expr: m[1], nanos: false }
  return null
}

/** Seconds a wait asks for, null when the source does not say. */
export function waitSeconds(wait: string, src: string, at = src.length): number | null {
  const length = waitLength(wait)
  return length ? lengthSeconds(length.expr, src, at, length.nanos) : null
}

/** A wait the app runs: a sleep in a task, or a run later (`asyncAfter`, a `Timer`). */
const WAIT = /Task\.sleep\s*\(|asyncAfter\s*\(|Timer\.scheduledTimer\s*\(|\bTimer\s*\(\s*timeInterval/g

/**
 * Something taken away: `x = nil`, `x = false`, `f(false)`, or a call whose name says it (dismiss,
 * close, clear, hide, remove, uncover, expire, withdraw, collapse). Read from the work the app's
 * long waits run (2026-11-25: `dismiss()` and `clearResentNotice()` were missed by the first form).
 */
const TAKE_AWAY = new RegExp(
  [
    String.raw`(?<![=!<>])\b[A-Za-z_][\w.?]*(?:\[[^\]\n]*\])?\s*=\s*(?:nil|false)\b`,
    String.raw`\b\w+\(\s*false\s*\)`,
    String.raw`(?<![\w])(?:\w+\??\.)*(?:dismiss|onDismiss|close|clear|hide|remove|uncover|expire|withdraw|collapse)\w*\s*(?:\(|\{)`,
  ].join('|'),
  'g',
)

export interface TimedHide {
  file: string
  line: number
  /** `wait`: a wait whose work takes something away; `window`: a date window. */
  kind: 'wait' | 'window'
  /** The wait or the window as written. */
  wait: string
  /** What is taken away (a wait), or the window's name (a date window). */
  takes: string
}

/** The work a wait runs: the rest of a sleeping task, or the closure or work item it hands over. */
function workOf(src: string, waitAt: number, argEnd: number, wait: string): string {
  if (/^Task\.sleep/.test(wait)) return restOfClosure(src, argEnd)
  // `execute: reset`: the work item of that name defined nearest above the wait is what runs.
  const item = /(?:execute|block):\s*(\w+)\s*\)$/.exec(wait)?.[1]
  if (item) {
    const defs = [...src.matchAll(new RegExp(`\\b${item}\\s*=\\s*DispatchWorkItem\\s*(?:\\([^)]*\\))?\\s*\\{`, 'g'))]
    const def = defs.filter((d) => d.index < waitAt).pop() ?? defs[0]
    return def ? closureAt(src, def.index + def[0].length - 1) : ''
  }
  // A closure passed inside the parentheses (`execute: { ... }`, `block: { ... }`).
  const inner = /(?:execute|block):\s*\{/.exec(wait)
  if (inner) return closureAt(src, waitAt + inner.index + inner[0].length - 1)
  // A trailing closure.
  const open = src.indexOf('{', argEnd)
  return open >= 0 && /^\s*$/.test(src.slice(argEnd, open)) ? closureAt(src, open) : ''
}

/** Every wait of a second or more (or of a length the source does not say) and what its work takes away. */
function timedWaits(file: string, src: string): TimedHide[] {
  const found: TimedHide[] = []
  for (const m of src.matchAll(WAIT)) {
    const open = src.indexOf('(', m.index)
    const argEnd = pastParen(src, open)
    const wait = src.slice(m.index, argEnd)
    const seconds = waitSeconds(wait, src, m.index)
    if (seconds !== null && seconds < 1) continue
    const work = workOf(src, m.index, argEnd, wait)
    // Every take-away in the work, not only the first: a known one never hides the next.
    for (const t of work.matchAll(TAKE_AWAY)) {
      found.push({
        file,
        line: lineOf(src, m.index),
        kind: 'wait',
        wait: wait.replace(/\s+/g, ' '),
        takes: t[0].replace(/\s*[({]$/, '').replace(/\s+/g, ' '),
      })
    }
  }
  return found
}

const NOW = String.raw`(?:Date\(\)|Date\.now|\.now\(\)|\.now|now\(\)|\bnow|Self\.now\(\)|env\.now\(\)|s\.now)`

/**
 * Date windows: a deadline stored for later (`hiddenUntil[id] = Date().addingTimeInterval(span)`,
 * `quietUntil = .now + x`) and a check of how long ago something was stamped
 * (`Date().timeIntervalSince(armedAt) < window`). A local `let` deadline (a loop's own budget) is not
 * one: nothing is shown by it. Lengths known to be under a second are left out.
 */
function dateWindows(file: string, src: string): TimedHide[] {
  const found: TimedHide[] = []
  const push = (at: number, text: string, name: string, length: string) => {
    const seconds = lengthSeconds(length, src, at)
    if (seconds !== null && seconds < 1) return
    found.push({ file, line: lineOf(src, at), kind: 'window', wait: text.replace(/\s+/g, ' '), takes: name })
  }
  const deadline = new RegExp(
    String.raw`(?<!\b(?:let|var)\s+)\b([A-Za-z_][\w.?]*)(?:\[[^\]\n]*\])?\s*=\s*` +
      String.raw`(?:${NOW}\s*(?:\.addingTimeInterval\(\s*([^)\n]+?)\s*\)|\+\s*([^\n]+?))|Date\(timeIntervalSinceNow:\s*([^)\n]+?)\s*\))\s*\}*\s*$`,
    'gm',
  )
  for (const m of src.matchAll(deadline)) {
    const length = m[2] ?? m[3] ?? m[4]
    if (/^-/.test(length.trim())) continue
    push(m.index, m[0], m[1].split('.').pop()!.replace(/\?$/, ''), length)
  }
  const age = new RegExp(
    String.raw`timeIntervalSince\(\s*([^()\n]*(?:\([^()\n]*\))?[^()\n]*)\)\s*(?:<=?|>=?)\s*([\w.()]+(?:\s*[*+]\s*[\w.()]+)?)`,
    'g',
  )
  for (const m of src.matchAll(age)) {
    push(m.index, m[0], `since ${m[1].replace(/\s+/g, '')}`, m[2].replace(/^NoticeTiming\.seconds\((.*)\)$/, '$1'))
  }
  return found
}

/** Everything one Swift source takes away on a clock (comments and strings already blanked). */
export function timedHides(file: string, src: string): TimedHide[] {
  return [...timedWaits(file, src), ...dateWindows(file, src)]
}

/** A take-away waits through NoticeTiming: its wait or its window names it. */
export const throughNoticeTiming = (h: TimedHide) => /NoticeTiming/.test(h.wait)

export interface KnownHide {
  file: string
  takes: string
  why: string
  /** How many take-aways of this file and text it covers (default 1): one more is not covered. */
  count?: number
}

/**
 * The take-aways a KNOWN list does not cover. Each entry covers `count` take-aways of its file and
 * text, so a second one with the same text in the same file still has to be judged on its own.
 */
export function uncovered(hides: TimedHide[], known: KnownHide[]): TimedHide[] {
  const left = new Map(known.map((k) => [`${k.file}\u0000${k.takes}`, k.count ?? 1]))
  return hides.filter((h) => {
    const key = `${h.file}\u0000${h.takes}`
    const n = left.get(key) ?? 0
    if (n <= 0) return true
    left.set(key, n - 1)
    return false
  })
}
