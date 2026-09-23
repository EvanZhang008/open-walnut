/**
 * Find a setting: a pure client-side matcher over nav metadata (labels,
 * titles, descriptions, keywords). Never searches server data or field values.
 *
 * Rules: the query splits on whitespace and EVERY term must appear (as a
 * substring, case-insensitive) somewhere in the entry. Rank: label prefix,
 * then word-start hits before mid-word ones (`agent` in `coding agent` beats
 * `subagent`), then label > keyword > description, then an exact keyword,
 * then nav order (compareHits). A folded section's label and title count as its owner's
 * label level, its keywords and description as the owner's.
 */
import type { SettingsKeyword } from './core-settings-registry'

export interface FilterEntry {
  /** Stable key: a pane id, or `link:<id>` for a page link. */
  key: string
  kind: 'pane' | 'link'
  label: string
  /** Other names at label level: the title and every folded section's label and title. */
  names?: readonly string[]
  /**
   * Folded sections' labels and titles: they rank at keyword level, so a title that
   * merely mentions a term ("Use an API instead of Claude Code") never outranks the
   * pane whose own keyword it is (N17), but a query that starts one still opens it first.
   */
  foldedNames?: readonly string[]
  descriptions?: readonly string[]
  keywords?: readonly SettingsKeyword[]
}

export interface FilterHit {
  key: string
  kind: 'pane' | 'link'
  /** 0 label prefix, 1 label substring, 2 keyword, 3 description. */
  level: 0 | 1 | 2 | 3
  wordStart: boolean
  /** The whole query is one of the entry's names or keyword words, exactly. */
  exact: boolean
  /** Position in the input list (nav order). */
  order: number
  /** Ranges in `label` to set in 600 weight. */
  labelRanges: Array<[number, number]>
  /** Text for `Matches "<hint>"`, or null when the label itself matched. */
  hint: string | null
  /** Row id to scroll to when the hit came from an anchored keyword. */
  anchor: string | null
}

export const HINT_MAX = 32

/** Fixed keywords for the off-page links (they have no registry entry). */
export const PAGE_LINK_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  agents: ['agent', 'persona'],
  skills: ['skill'],
  commands: ['slash', 'command'],
  memory: ['memory', 'remember'],
}

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

function isWordStartAt(text: string, idx: number): boolean {
  return idx === 0 || !/[\p{L}\p{N}]/u.test(text[idx - 1] ?? '')
}

/** Best occurrence of `term` in `text`: word-start first. -1 when absent. */
function findTerm(text: string, term: string): { idx: number; wordStart: boolean } {
  let idx = text.indexOf(term)
  const first = idx
  while (idx !== -1) {
    if (isWordStartAt(text, idx)) return { idx, wordStart: true }
    idx = text.indexOf(term, idx + 1)
  }
  return { idx: first, wordStart: false }
}

/**
 * Cut a hint to HINT_MAX chars with `...`, on word boundaries, with the
 * matched word in view (N3-13): from the start when the match is near it
 * (no leading `...`), else from the matched word. Never mid-word unless a
 * single word is longer than the whole budget.
 */
export function truncateHint(text: string, hitIndex = 0): string {
  if (text.length <= HINT_MAX) return text
  const wordEnd = (i: number) => {
    const sp = text.indexOf(' ', i)
    return sp === -1 ? text.length : sp
  }
  const nearStart = wordEnd(Math.max(0, hitIndex)) <= HINT_MAX - 3
  const start = nearStart || hitIndex <= 0 ? 0 : text.lastIndexOf(' ', hitIndex - 1) + 1
  const prefix = start > 0 ? '...' : ''
  const body = text.slice(start)
  if (prefix.length + body.length <= HINT_MAX) return prefix + body
  const budget = HINT_MAX - prefix.length - 3
  let cut = ''
  for (const word of body.split(' ')) {
    const next = cut ? `${cut} ${word}` : word
    if (next.length > budget) break
    cut = next
  }
  if (!cut) cut = body.slice(0, budget)
  return `${prefix}${cut.replace(/[\s,;:.]+$/, '')}...`
}

function kwWord(k: SettingsKeyword): string {
  return typeof k === 'string' ? k : k.word
}

function kwText(k: SettingsKeyword): string {
  return typeof k === 'string' ? k : `${k.word} ${k.rowLabel}`
}

function labelRangesFor(label: string, terms: string[]): Array<[number, number]> {
  const lower = label.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    let idx = lower.indexOf(term)
    while (idx !== -1) {
      ranges.push([idx, idx + term.length])
      idx = lower.indexOf(term, idx + term.length)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

interface Field {
  lower: string
  raw: string
  level: 1 | 2 | 3
  own: boolean
  kw?: SettingsKeyword
  /** A folded section's label or title: keyword level, but a prefix still ranks first. */
  folded?: boolean
}

function fieldsOf(entry: FilterEntry): Field[] {
  const fields: Field[] = [{ lower: entry.label.toLowerCase(), raw: entry.label, level: 1, own: true }]
  for (const name of entry.names ?? []) fields.push({ lower: name.toLowerCase(), raw: name, level: 1, own: false })
  for (const name of entry.foldedNames ?? []) fields.push({ lower: name.toLowerCase(), raw: name, level: 2, own: false, folded: true })
  for (const kw of entry.keywords ?? []) {
    fields.push({ lower: kwText(kw).toLowerCase(), raw: typeof kw === 'string' ? kw : kw.rowLabel, level: 2, own: false, kw })
  }
  for (const d of entry.descriptions ?? []) fields.push({ lower: d.toLowerCase(), raw: d, level: 3, own: false })
  return fields
}

/** A bare keyword reads like a label: first letter up (`timeout` -> `Timeout`, N17). */
function asLabel(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word
}

function hintFrom(field: Field, term: string): string {
  // Truncation keeps the matched word in view (N17).
  if (field.kw && typeof field.kw !== 'string') {
    const label = field.kw.rowLabel
    return truncateHint(label, Math.max(0, label.toLowerCase().indexOf(term)))
  }
  if (field.kw) return truncateHint(asLabel(kwWord(field.kw)))
  const idx = field.lower.indexOf(term)
  return truncateHint(field.raw, field.level === 3 || field.folded ? Math.max(0, idx) : 0)
}

/** Score one entry against the terms; null when some term is missing. */
export function matchEntry(entry: FilterEntry, terms: string[], order: number): FilterHit | null {
  if (terms.length === 0) return null
  const fields = fieldsOf(entry)
  let level = 1
  let wordStart = true
  for (const term of terms) {
    let best: { level: number; wordStart: boolean } | null = null
    for (const f of fields) {
      const found = findTerm(f.lower, term)
      if (found.idx === -1) continue
      if (!best || f.level < best.level || (f.level === best.level && found.wordStart && !best.wordStart)) {
        best = { level: f.level, wordStart: found.wordStart }
      }
    }
    if (!best) return null
    level = Math.max(level, best.level)
    wordStart = wordStart && best.wordStart
  }
  const phrase = terms.join(' ')
  if (fields.some((f) => (f.level === 1 || f.folded) && f.lower.startsWith(phrase))) {
    level = 0
    wordStart = true
  }

  const own = fields[0]
  const ownAll = terms.every((t) => own.lower.includes(t))
  let hint: string | null = null
  let anchor: string | null = null
  if (!ownAll) {
    let pick: { f: Field; count: number; ws: boolean } | null = null
    for (const f of fields.slice(1)) {
      const hits = terms.filter((t) => f.lower.includes(t))
      if (hits.length === 0) continue
      const ws = findTerm(f.lower, hits[0]).wordStart
      const better = !pick
        || hits.length > pick.count
        || (hits.length === pick.count && f.level < pick.f.level)
        || (hits.length === pick.count && f.level === pick.f.level && ws && !pick.ws)
        || (hits.length === pick.count && f.level === pick.f.level && ws === pick.ws
          && typeof f.kw === 'object' && typeof pick.f.kw !== 'object')
      if (better) pick = { f, count: hits.length, ws }
    }
    if (pick) {
      hint = hintFrom(pick.f, terms.find((t) => pick!.f.lower.includes(t)) ?? terms[0])
      if (typeof pick.f.kw === 'object' && pick.f.kw.anchor) anchor = pick.f.kw.anchor
    }
  }
  const exact = fields.some((f) => (f.kw ? kwWord(f.kw).toLowerCase() === phrase : f.lower === phrase))
  return {
    key: entry.key,
    kind: entry.kind,
    level: level as FilterHit['level'],
    wordStart,
    exact,
    order,
    labelRanges: labelRangesFor(entry.label, terms),
    hint,
    anchor,
  }
}

/**
 * A label prefix ranks first; after that a word-start hit at any level beats a
 * mid-word one (`port` finds SDK port before Bug Re-port, F22), then the
 * level, then an exact keyword beats a longer one (`model` opens Engines, not
 * Tasks' `jev model`), then nav order.
 */
export function compareHits(a: FilterHit, b: FilterHit): number {
  if ((a.level === 0) !== (b.level === 0)) return a.level === 0 ? -1 : 1
  if (a.wordStart !== b.wordStart) return a.wordStart ? -1 : 1
  if (a.level !== b.level) return a.level - b.level
  if (a.exact !== b.exact) return a.exact ? -1 : 1
  return a.order - b.order
}

/** Every entry matching `query`, best first. Empty query: no hits. */
export function filterEntries(entries: readonly FilterEntry[], query: string): FilterHit[] {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const hits: FilterHit[] = []
  entries.forEach((entry, i) => {
    const hit = matchEntry(entry, terms, i)
    if (hit) hits.push(hit)
  })
  return hits.sort(compareHits)
}

/** What Enter opens: the best pane hit; a page link only when no pane matched. */
export function primaryHit(hits: readonly FilterHit[]): FilterHit | null {
  return hits.find((h) => h.kind === 'pane') ?? hits[0] ?? null
}
