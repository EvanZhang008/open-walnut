/**
 * Error rates of one engine text against the reference, as the 2026-11-21
 * benchmark scored them (bench score.py `toks`/`lev`/`err`): a Chinese
 * character is one unit, a Latin word (letters and digits, with an
 * apostrophe suffix) is one unit, after NFKC and lower case; punctuation,
 * spaces and the judge's `[?` `]` unsure marks are not units. The mixed rate is
 * edits over reference units; the CJK and Latin rates align each script alone.
 *
 * One tokenizer serves the score and the word diff, so a token keeps its place
 * in the original text. The edit distance yields to the event loop on long
 * takes (an hour of speech is about 15,000 units).
 */
import type { TakeScore } from './types.js'

export interface Token { key: string; from: number; to: number; cjk: boolean }

const CJK_CHAR = /[\u4e00-\u9fff\u3400-\u4dbf]/
// Fullwidth letters and digits are matched too: NFKC makes them Latin.
const TOKEN = /[\u4e00-\u9fff\u3400-\u4dbf]|[A-Za-z0-9\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]+(?:'[A-Za-z\uff21-\uff3a\uff41-\uff5a]+)?/g

export function tokens(text: string | undefined): Token[] {
  const out: Token[] = []
  for (const m of (text ?? '').matchAll(TOKEN)) {
    const key = m[0].normalize('NFKC').toLowerCase()
    out.push({ key, from: m.index!, to: m.index! + m[0].length, cjk: CJK_CHAR.test(key) })
  }
  return out
}

const YIELD_CELLS = 2_000_000
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Levenshtein distance over token keys. */
export async function lev(a: string[], b: string[]): Promise<number> {
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Uint32Array(b.length + 1)
  let cur = new Uint32Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  let cells = 0
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    const x = a[i - 1]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x === b[j - 1] ? 0 : 1))
    }
    ;[prev, cur] = [cur, prev]
    cells += b.length
    if (cells >= YIELD_CELLS) { cells = 0; await yieldNow() }
  }
  return prev[b.length]!
}

const termKey = (term: string) => term.toLowerCase().trim().replace(/\s+/g, ' ')

/** The text as terms are counted in it: NFKC, lower case, one space, no unsure marks, padded. */
function termText(text: string): string {
  return ` ${text.normalize('NFKC').toLowerCase().replace(/\[\?/g, '').replace(/\]/g, '').replace(/\s+/g, ' ')} `
}

function termPattern(term: string): RegExp {
  const escaped = termKey(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g')
}

/** How often a term is written the same way (any case) in the text. */
export function countTerm(text: string, term: string): number {
  if (!termKey(term)) return 0
  return termText(text).match(termPattern(term))?.length ?? 0
}

/**
 * The user's terms spoken in a reference, one entry per time: longest first,
 * and a span counted once ("Claude Code" is not also "Claude").
 */
export function termsSpoken(reference: string, terms: string[]): string[] {
  let text = termText(reference)
  const out: string[] = []
  const sorted = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  for (const term of sorted) {
    const pattern = termPattern(term)
    const hits = text.match(pattern)?.length ?? 0
    if (!hits) continue
    for (let i = 0; i < hits; i++) out.push(term)
    text = text.replace(pattern, (m) => ' '.repeat(m.length))
  }
  return out
}

/** One engine text scored against the reference. */
export async function scoreText(hyp: string, reference: string, terms: string[] = []): Promise<TakeScore> {
  const h = tokens(hyp)
  const r = tokens(reference)
  const keys = (list: Token[], cjk?: boolean) => list.filter((t) => cjk === undefined || t.cjk === cjk).map((t) => t.key)
  const need = new Map<string, number>()
  for (const term of terms) {
    const k = termKey(term)
    if (k) need.set(k, (need.get(k) ?? 0) + 1)
  }
  let termsHit = 0
  for (const [k, n] of need) termsHit += Math.min(countTerm(hyp, k), n)
  const rc = keys(r, true)
  const rl = keys(r, false)
  return {
    edits: await lev(keys(h), keys(r)),
    n: r.length,
    cjkEdits: await lev(keys(h, true), rc),
    cjkN: rc.length,
    latEdits: await lev(keys(h, false), rl),
    latN: rl.length,
    termsHit,
    termsNeed: [...need.values()].reduce((a, b) => a + b, 0),
  }
}

export interface DiffSegment {
  /**
   * same: the engine's text as it is (words that match, and every space and punctuation mark);
   * changed: words heard as other words; extra: words the reference does not have; missing: words
   * only the reference has (no engine text: the pane marks the place and lists the words apart).
   */
  op: 'same' | 'changed' | 'extra' | 'missing'
  /** The engine's own text for this stretch (empty for missing). */
  text: string
  /** The reference's words for a changed or missing stretch. */
  ref?: string
}

/** Past this many cells a diff is not aligned word by word (the whole text is one segment). */
const MAX_DIFF_CELLS = 4_000_000

/**
 * The engine text cut into segments against the reference. Joining the `text`
 * of every segment gives the engine text back exactly. A changed or extra
 * segment covers its words only, from the first word's start to the last
 * word's end: the spaces and punctuation around it stay in the same segments,
 * so a mark never takes a space with it. Neighbouring edits are one stretch
 * ("tail skill" heard for "Tailscale" is one changed segment). A missing
 * stretch sits just before the next word the engine has (at the end when none).
 */
export async function wordDiff(hyp: string, reference: string): Promise<DiffSegment[]> {
  const h = tokens(hyp)
  const r = tokens(reference)
  if (!h.length) return r.length ? [{ op: 'missing', text: '', ref: reference.trim() }, ...(hyp ? [{ op: 'same' as const, text: hyp }] : [])] : hyp ? [{ op: 'same', text: hyp }] : []
  if ((h.length + 1) * (r.length + 1) > MAX_DIFF_CELLS) return [{ op: 'same', text: hyp }]
  const w = r.length + 1
  const d = new Uint32Array((h.length + 1) * w)
  for (let j = 0; j <= r.length; j++) d[j] = j
  let cells = 0
  for (let i = 1; i <= h.length; i++) {
    d[i * w] = i
    for (let j = 1; j <= r.length; j++) {
      const sub = d[(i - 1) * w + j - 1]! + (h[i - 1]!.key === r[j - 1]!.key ? 0 : 1)
      d[i * w + j] = Math.min(d[(i - 1) * w + j]! + 1, d[i * w + j - 1]! + 1, sub)
    }
    cells += r.length
    if (cells >= YIELD_CELLS) { cells = 0; await yieldNow() }
  }
  // Walk back: one step per token, `same` where the words match. Among equally short paths a
  // match wins, then a word left out or added, and a substitution last: that keeps the most
  // words matched ("tail scale, is" against "Tailscale, is the" keeps its "is").
  type Step = { same: boolean; hi?: number; rj?: number }
  const steps: Step[] = []
  let i = h.length
  let j = r.length
  while (i > 0 || j > 0) {
    const here = d[i * w + j]!
    const match = i > 0 && j > 0 && h[i - 1]!.key === r[j - 1]!.key
    if (match && here === d[(i - 1) * w + j - 1]!) {
      steps.push({ same: true, hi: i - 1, rj: j - 1 }); i--; j--
    } else if (i > 0 && here === d[(i - 1) * w + j]! + 1) {
      steps.push({ same: false, hi: i - 1 }); i--
    } else if (j > 0 && here === d[i * w + j - 1]! + 1) {
      steps.push({ same: false, rj: j - 1 }); j--
    } else {
      steps.push({ same: false, hi: i - 1, rj: j - 1 }); i--; j--
    }
  }
  steps.reverse()
  const segments: DiffSegment[] = []
  const plain = (text: string) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last?.op === 'same') last.text += text
    else segments.push({ op: 'same', text })
  }
  let pos = 0
  /** The engine's next word not yet written out. */
  let nextWord = 0
  for (let k = 0; k < steps.length;) {
    const same = steps[k]!.same
    const run: Step[] = []
    while (k < steps.length && steps[k]!.same === same) run.push(steps[k++]!)
    const hs = run.filter((s) => s.hi !== undefined).map((s) => s.hi!)
    const rs = run.filter((s) => s.rj !== undefined).map((s) => s.rj!)
    if (!hs.length) {
      // Missing only: placed before the engine's next word, its spaces kept before it.
      const next = h[nextWord]
      plain(hyp.slice(pos, next ? next.from : hyp.length))
      pos = next ? next.from : hyp.length
      segments.push({ op: 'missing', text: '', ref: reference.slice(r[rs[0]!]!.from, r[rs[rs.length - 1]!]!.to) })
      continue
    }
    const from = h[hs[0]!]!.from
    const to = h[hs[hs.length - 1]!]!.to
    plain(hyp.slice(pos, from))
    if (same) plain(hyp.slice(from, to))
    else if (rs.length) segments.push({ op: 'changed', text: hyp.slice(from, to), ref: reference.slice(r[rs[0]!]!.from, r[rs[rs.length - 1]!]!.to) })
    else segments.push({ op: 'extra', text: hyp.slice(from, to) })
    pos = to
    nextWord = hs[hs.length - 1]! + 1
  }
  plain(hyp.slice(pos))
  return segments
}
