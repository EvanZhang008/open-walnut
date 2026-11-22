/**
 * answer-text.ts: the small helpers every op answer shape shares (answer.ts holds the policy).
 *
 * Every text a shape shortens ends with `… [Walnut cut: N more characters]` (cutMark), the same
 * form cutToFit writes, because the executor refuses a write whose arguments hold that mark
 * (cutTextRefusal): an agent that read a cut note and wrote it back would delete the rest.
 * So no shape cuts a text by hand; it calls cutText.
 */
import { cutMark } from './answer.js'

export type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const objOf = (v: unknown): Obj => (isObj(v) ? v : {})

/** Characters of `v` as JSON: what an answer's cap counts. */
export const jsonSize = (v: unknown): number => (JSON.stringify(v) ?? 'null').length

/** Characters of a string's content as JSON (its escapes counted, its quotes not). */
export const jsonChars = (s: string): number => JSON.stringify(s).length - 2

const tail = (more: number): string => `… ${cutMark(more)}`

/**
 * `text` held to `max` characters, the mark included: whole when it fits, else its head (never a
 * split surrogate pair; at a line end when `lineEnd` and one is near) and the mark saying how many
 * characters were left out. `json` measures as an answer's cap does (a tab or a quote is two), so
 * a text that "fits" here also fits there. A value that is not a string is ''.
 */
export function cutText(text: unknown, max: number, opts: { json?: boolean; lineEnd?: boolean } = {}): string {
  const s = typeof text === 'string' ? text : ''
  const measure = opts.json ? jsonChars : (x: string) => x.length
  if (s.length <= max && measure(s) <= max) return s
  const room = Math.max(0, max - measure(tail(s.length)))
  let used = 0
  let end = 0
  for (const ch of s) {
    const w = opts.json ? jsonChars(ch) : ch.length
    if (used + w > room) break
    used += w
    end += ch.length
  }
  let head = s.slice(0, end)
  if (opts.lineEnd) {
    const nl = head.lastIndexOf('\n')
    if (nl > head.length * 0.8) head = head.slice(0, nl)
  }
  return `${head}${tail(s.length - head.length)}`
}
