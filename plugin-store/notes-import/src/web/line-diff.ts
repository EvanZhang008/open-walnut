/**
 * A line diff of the person's note against Notion's version, for the comparison view:
 * one column where a line only in theirs is "mine", a line only in Notion's is "notion",
 * and runs of lines both have fold to a count so the differences stand out.
 */

export type DiffRow =
  | { kind: 'same' | 'mine' | 'notion'; text: string }
  | { kind: 'fold'; count: number }

export interface LineDiff {
  rows: DiffRow[]
  mine: number
  notion: number
}

/** Beyond this many line pairs the table would be too big to build in a click: compare as sets instead. */
const MAX_CELLS = 4_000_000
/** Lines the same around a change that stay visible; a longer run of them folds. */
const CONTEXT = 2

const norm = (line: string) => line.trimEnd()

export function diffNoteLines(mine: string, notion: string): LineDiff {
  const a = mine.replace(/\r\n/g, '\n').split('\n')
  const b = notion.replace(/\r\n/g, '\n').split('\n')
  const raw = a.length * b.length > MAX_CELLS ? bySets(a, b) : byLcs(a, b)
  // Blank lines are shown where they are but not counted: a count names lines of text.
  const count = (kind: Raw['kind']) => raw.filter((r) => r.kind === kind && r.text.trim()).length
  return { rows: fold(raw), mine: count('mine'), notion: count('notion') }
}

type Raw = { kind: 'same' | 'mine' | 'notion'; text: string }

function byLcs(a: string[], b: string[]): Raw[] {
  // Common head and tail first: most edits touch a few lines, so the table stays small.
  let head = 0
  while (head < a.length && head < b.length && norm(a[head]) === norm(b[head])) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && norm(a[a.length - 1 - tail]) === norm(b[b.length - 1 - tail])) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const n = x.length
  const m = y.length
  const len = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * (m + 1) + j] = norm(x[i]) === norm(y[j])
        ? len[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(len[(i + 1) * (m + 1) + j], len[i * (m + 1) + j + 1])
    }
  }
  const out: Raw[] = a.slice(0, head).map((text) => ({ kind: 'same' as const, text }))
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && norm(x[i]) === norm(y[j])) { out.push({ kind: 'same', text: x[i] }); i++; j++ }
    else if (j < m && (i >= n || len[i * (m + 1) + j + 1] >= len[(i + 1) * (m + 1) + j])) { out.push({ kind: 'notion', text: y[j] }); j++ }
    else { out.push({ kind: 'mine', text: x[i] }); i++ }
  }
  // Within one change, the person's lines read before Notion's.
  for (let k = 0; k < out.length; k++) {
    if (out[k].kind === 'same') continue
    let end = k
    while (end < out.length && out[end].kind !== 'same') end++
    const run = out.slice(k, end)
    out.splice(k, run.length, ...run.filter((r) => r.kind === 'mine'), ...run.filter((r) => r.kind === 'notion'))
    k = end
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text })
  return out
}

/** A very long note: each side's lines the other lacks, in their order. */
function bySets(a: string[], b: string[]): Raw[] {
  const inA = new Set(a.map(norm))
  const inB = new Set(b.map(norm))
  return [
    ...a.map((text) => ({ kind: inB.has(norm(text)) ? 'same' as const : 'mine' as const, text })),
    ...b.filter((text) => !inA.has(norm(text))).map((text) => ({ kind: 'notion' as const, text })),
  ]
}

function fold(raw: Raw[]): DiffRow[] {
  const out: DiffRow[] = []
  let k = 0
  while (k < raw.length) {
    if (raw[k].kind !== 'same') { out.push(raw[k]); k++; continue }
    let end = k
    while (end < raw.length && raw[end].kind === 'same') end++
    const keepHead = k === 0 ? 0 : CONTEXT
    const keepTail = end === raw.length ? 0 : CONTEXT
    if (end - k > keepHead + keepTail + 1) {
      out.push(...raw.slice(k, k + keepHead))
      out.push({ kind: 'fold', count: end - k - keepHead - keepTail })
      out.push(...raw.slice(end - keepTail, end))
    } else {
      out.push(...raw.slice(k, end))
    }
    k = end
  }
  return out
}
