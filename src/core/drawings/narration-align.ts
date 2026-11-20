/**
 * Which elements each sentence of a walkthrough was about, and the two views an AI reads:
 *
 *  - the OVERVIEW (coarse, the default): one line per part, a run of sentences about the same
 *    element, with its time span, the element and the gist of what was said;
 *  - the DETAIL of one part or time span (fine, asked for): each sentence's times, the elements it
 *    was matched to and why, and every canvas event in that span.
 *
 * A sentence is matched by evidence on the shared clock, scored and ranked (the rules are written
 * in the drawing design: pointer on it up to 3, named in the words 3, selected up to 2, just drawn
 * or changed 1). The pointer and the selection count by how much of the sentence they cover, so
 * the element the person moved to while speaking wins over the one they just left. Pure
 * functions: no file, no clock.
 */

import type { NarrationEvent, NarrationSpeech, NarrationTake } from './narration.js'

/** Before a sentence starts, how far back the pointer still counts (people point, then speak). */
const POINT_LEAD_MS = 1_500
/** How long after a shape was drawn or changed "this" may still mean it. */
const EDIT_LEAD_MS = 5_000
/** A selection larger than this is a group, not "this one". */
const SELECTION_MAX = 5
/** A pause longer than this starts a new part even about the same element. */
const PART_GAP_MS = 20_000
const GIST_MAX = 160
const MAX_ABOUT = 3
export const OVERVIEW_PARTS_MAX = 40
export const OVERVIEW_TAKES_MAX = 10
const DETAIL_LINES_MAX = 300

export interface Mention {
  id: string
  label: string
  score: number
  why: string[]
  /** The latest evidence time, to break ties. */
  last: number
  /** Where its name appears in the words (Infinity: not named), the next tie-break. */
  pos: number
}

export interface AlignedSentence extends NarrationSpeech {
  about: Mention[]
}

export interface NarrationPart {
  n: number
  t0: number
  t1: number
  sentences: AlignedSentence[]
  /** The elements this part is about, most mentioned first. */
  about: Array<{ id: string; label: string }>
}

/** `m:ss`, or `m:ss.s` with tenths. */
export function clock(ms: number, tenths = false): string {
  // Rounded first, so 59.96 s reads 1:00.0, never 0:60.0.
  const units = tenths ? Math.round(Math.max(0, ms) / 100) : Math.floor(Math.max(0, ms) / 1000)
  const perMinute = tenths ? 600 : 60
  const m = Math.floor(units / perMinute)
  const rest = units - m * perMinute
  const sec = tenths ? `${String(Math.floor(rest / 10)).padStart(2, '0')}.${rest % 10}` : String(rest).padStart(2, '0')
  return `${m}:${sec}`
}

function labelOf(id: string, labels: ReadonlyMap<string, string>, fallback: string): string {
  return labels.get(id) || fallback || 'unlabelled element'
}

/** Labels events carried, latest first, for elements the scene no longer has. */
function eventLabels(events: readonly NarrationEvent[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of events) e.ids.forEach((id, i) => { if (e.labels[i]) out.set(id, e.labels[i]) })
  return out
}

/**
 * How a label is found in the words, or null when it is too short to mean anything there: a Latin
 * name stands alone ("orders" is not in "order_items") and has 3 letters or more, or is a short
 * acronym in capitals ("DB", matched in its case); CJK words have no spaces and count from 2.
 */
function nameMatcher(label: string): { re: RegExp; cased: boolean } | null {
  const words = label.trim()
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (/^[A-Za-z0-9_]/.test(words)) {
    const acronym = /^[A-Z0-9]{2}$/.test(words)
    if (words.length < 3 && !acronym) return null
    const w = acronym ? words : words.toLowerCase()
    return { re: new RegExp(`(^|[^A-Za-z0-9_])${escape(w)}($|[^A-Za-z0-9_])`), cased: acronym }
  }
  return words.length < 2 ? null : { re: new RegExp(escape(words.toLowerCase())), cased: false }
}

/** How much of [from, to] the span [a, b] covers, 0 to 1 (a point-like sentence counts whole). */
function share(a: number, b: number, from: number, to: number): number {
  const len = to - from
  if (len <= 0) return a <= to && b >= from ? 1 : 0
  return Math.max(0, Math.min(b, to) - Math.max(a, from)) / len
}

/** The last index whose `t` is at or before `at` in a list sorted by `t` (-1: none). */
function lastAtOrBefore(list: ReadonlyArray<{ t: number }>, at: number): number {
  let lo = 0
  let hi = list.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].t <= at) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

interface Span { t: number; end: number; ids: string[] }

/**
 * A take's evidence, indexed once: the pointer's rests and the selections as spans one after
 * another (one pointer, one selection at a time), and the edits, each sorted by time, so a sentence
 * looks only at what is near it.
 */
function evidenceOf(take: NarrationTake, takeEnd: number) {
  const points: Span[] = []
  const selections: Span[] = []
  const edits: NarrationEvent[] = []
  for (const e of take.events) {
    if (e.kind === 'point') {
      const open = points.at(-1)
      if (open && open.end === Infinity) open.end = e.t
      if (e.ids[0]) points.push({ t: e.t, end: e.untilT ?? Infinity, ids: e.ids.slice(0, 1) })
    } else if (e.kind === 'select') {
      const open = selections.at(-1)
      if (open) open.end = e.t
      selections.push({ t: e.t, end: takeEnd, ids: e.ids })
    } else edits.push(e)
  }
  for (const p of points) if (p.end === Infinity) p.end = takeEnd
  return { points, selections, edits }
}

/**
 * A selection counts less the longer before the sentence it was made (a shape drawn or picked
 * earlier stays selected while the person points elsewhere): whole up to SELECTION_NEW_MS, a
 * quarter at SELECTION_FRESH_MS, nothing after.
 */
const SELECTION_NEW_MS = 3_000
const SELECTION_FRESH_MS = 15_000

function freshness(madeAt: number, sentenceStart: number): number {
  const age = sentenceStart - madeAt
  if (age <= SELECTION_NEW_MS) return 1
  return 1 - (0.75 * (age - SELECTION_NEW_MS)) / (SELECTION_FRESH_MS - SELECTION_NEW_MS)
}

function takeEndOf(take: NarrationTake): number {
  let end = take.durationMs
  for (const s of take.speech) end = Math.max(end, s.t1)
  for (const e of take.events) end = Math.max(end, e.untilT ?? e.t)
  return end
}

/** Each sentence of a take with the elements it was about, best first. */
export function alignTake(take: NarrationTake, sceneLabels: ReadonlyMap<string, string>): AlignedSentence[] {
  const takeEnd = takeEndOf(take)
  const labels = new Map<string, string>([...eventLabels(take.events), ...sceneLabels])
  const names: Array<{ id: string; re: RegExp; cased: boolean }> = []
  for (const [id, label] of labels) {
    const m = nameMatcher(label)
    if (m) names.push({ id, ...m })
  }
  const { points, selections, edits } = evidenceOf(take, takeEnd)
  return take.speech.map((s) => {
    const hits = new Map<string, Mention>()
    const add = (id: string, score: number, why: string, at: number, pos = Infinity) => {
      const m = hits.get(id) ?? { id, label: labelOf(id, labels, ''), score: 0, why: [], last: -1, pos: Infinity }
      m.pos = Math.min(m.pos, pos)
      if (!m.why.includes(why)) {
        m.score = Math.round((m.score + score) * 100) / 100
        m.why.push(why)
      }
      m.last = Math.max(m.last, at)
      hits.set(id, m)
    }
    const pointFrom = s.t0 - POINT_LEAD_MS
    for (let i = lastAtOrBefore(points, s.t1); i >= 0 && points[i].end >= pointFrom; i--) {
      const p = points[i]
      // Resting on it while speaking counts most; having just left it before the first word, less.
      add(p.ids[0], (p.end >= s.t0 ? 1 : 0.5) + 2 * share(p.t, p.end, pointFrom, s.t1), `pointer on it from ${clock(p.t, true)}`, p.t)
    }
    for (let i = lastAtOrBefore(edits, s.t1); i >= 0 && edits[i].t >= s.t0 - EDIT_LEAD_MS; i--) {
      const e = edits[i]
      const verb = e.kind === 'add' ? 'drawn' : e.kind === 'edit' ? 'changed' : 'removed'
      for (const id of e.ids.slice(0, SELECTION_MAX)) add(id, 1, `${verb} at ${clock(e.t, true)}`, e.t)
    }
    for (let i = lastAtOrBefore(selections, s.t1); i >= 0 && selections[i].end > s.t0; i--) {
      const span = selections[i]
      if (span.ids.length === 0 || span.ids.length > SELECTION_MAX || span.t < s.t0 - SELECTION_FRESH_MS) continue
      const weight = (0.5 + 1.5 * share(span.t, span.end, s.t0, s.t1)) * freshness(span.t, s.t0)
      for (const id of span.ids) add(id, weight, `selected from ${clock(span.t, true)}`, span.t)
    }
    if (s.text) {
      const lower = s.text.toLowerCase()
      for (const { id, re, cased } of names) {
        const at = (cased ? s.text : lower).search(re)
        if (at >= 0) add(id, 3, 'named in the words', s.t0, at)
      }
    }
    const about = [...hits.values()]
      .sort((a, b) => b.score - a.score || b.last - a.last || a.pos - b.pos)
      .slice(0, MAX_ABOUT)
    return { ...s, about }
  })
}

/** Runs of sentences about the same element, a pause past PART_GAP_MS starting a new one. */
export function partsOf(sentences: readonly AlignedSentence[]): NarrationPart[] {
  const parts: NarrationPart[] = []
  let cur: (NarrationPart & { primary: string | null }) | null = null
  for (const s of sentences) {
    const primary = s.about[0]?.id ?? null
    const gap = cur ? s.t0 - cur.t1 : 0
    const sameTopic = cur && (primary === null || cur.primary === null || primary === cur.primary)
    if (!cur || !sameTopic || gap > PART_GAP_MS) {
      if (cur) parts.push(cur)
      cur = { n: parts.length + 1, t0: s.t0, t1: s.t1, sentences: [], about: [], primary }
    }
    cur.sentences.push(s)
    cur.t1 = Math.max(cur.t1, s.t1)
    if (cur.primary === null) cur.primary = primary
  }
  if (cur) parts.push(cur)
  for (const p of parts) {
    const count = new Map<string, { id: string; label: string; n: number }>()
    for (const s of p.sentences) {
      // Every element tied for the best match counts: "A follows B" is about both.
      const best = s.about[0]?.score
      for (const top of s.about.filter((m) => m.score === best)) {
        const c = count.get(top.id) ?? { id: top.id, label: top.label, n: 0 }
        c.n++
        count.set(top.id, c)
      }
    }
    // Ties keep the order they were first spoken in.
    p.about = [...count.values()].sort((a, b) => b.n - a.n).slice(0, MAX_ABOUT).map(({ id, label }) => ({ id, label }))
    delete (p as { primary?: unknown }).primary
  }
  return parts
}

function quote(s: string): string {
  return `"${s.replace(/\s+/g, ' ').trim()}"`
}

function elementsText(about: ReadonlyArray<{ id: string; label: string }>): string {
  return about.length ? about.map((a) => `${a.label} (${a.id})`).join(', ') : 'no element in particular'
}

function gistOf(part: NarrationPart): string {
  const said = part.sentences.filter((s) => s.text).map((s) => s.text.replace(/\s+/g, ' ').trim())
  const missing = part.sentences.length - said.length
  let gist = said.join(' ')
  if (gist.length > GIST_MAX) gist = `${gist.slice(0, GIST_MAX - 1)}…`
  const extra = [part.sentences.length > 1 ? `${part.sentences.length} sentences` : '', missing ? `${missing} not transcribed` : ''].filter(Boolean).join(', ')
  return `${gist ? quote(gist) : '(not transcribed)'}${extra ? ` (${extra})` : ''}`
}

/** Takes in the order they were recorded; the 1-based place in this list is a take's number. */
export function orderedTakes(takes: readonly NarrationTake[]): NarrationTake[] {
  return [...takes].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id))
}

function takeHead(n: number, take: NarrationTake, sentences: number, parts: number): string {
  const when = take.startedAt.slice(0, 16).replace('T', ' ')
  return `take ${n} · ${when} UTC · ${clock(take.durationMs)} · ${sentences} sentence${sentences === 1 ? '' : 's'} in ${parts} part${parts === 1 ? '' : 's'}`
}

/** The coarse view: every take (the newest OVERVIEW_TAKES_MAX), one line per part. */
export function narrationOverview(takes: readonly NarrationTake[], labels: ReadonlyMap<string, string>): string {
  const ordered = orderedTakes(takes)
  if (ordered.length === 0) return ''
  const lines = [`Walkthroughs (${ordered.length}): what the person said while drawing, lined up with the elements. For one part in detail (each sentence's times, what was drawn, selected and pointed at): walnut_drawing_narration {path, take, part}.`]
  const first = Math.max(0, ordered.length - OVERVIEW_TAKES_MAX)
  if (first > 0) lines.push(`(${first} older take${first === 1 ? '' : 's'} not listed: ask walnut_drawing_narration with take 1 to ${first})`)
  ordered.forEach((take, i) => {
    if (i < first) return
    const sentences = alignTake(take, labels)
    const parts = partsOf(sentences)
    lines.push(takeHead(i + 1, take, sentences.length, parts.length))
    if (parts.length === 0) lines.push('  (nothing was said)')
    for (const p of parts.slice(0, OVERVIEW_PARTS_MAX)) {
      lines.push(`  part ${p.n}  ${clock(p.t0)}-${clock(p.t1)}  ${elementsText(p.about)}: ${gistOf(p)}`)
    }
    if (parts.length > OVERVIEW_PARTS_MAX) lines.push(`  (${parts.length - OVERVIEW_PARTS_MAX} more parts: ask by part, or by from/to seconds)`)
  })
  return lines.join('\n')
}

/** When the pointer left the element a `point` event names: its untilT, else the next point. */
function pointEnd(events: readonly NarrationEvent[], i: number, takeEnd: number): number {
  const e = events[i]
  if (e.untilT !== undefined) return e.untilT
  for (let j = i + 1; j < events.length; j++) if (events[j].kind === 'point') return events[j].t
  return takeEnd
}

function eventLine(e: NarrationEvent, events: readonly NarrationEvent[], i: number, takeEnd: number, labels: ReadonlyMap<string, string>): string {
  const names = e.ids.slice(0, 8).map((id, k) => `${labelOf(id, labels, e.labels[k] ?? '')} (${id})`).join(', ') + (e.ids.length > 8 ? `, and ${e.ids.length - 8} more` : '')
  switch (e.kind) {
    case 'point': return e.ids[0] ? `${clock(e.t, true)} pointer on ${names} until ${clock(pointEnd(events, i, takeEnd), true)}` : `${clock(e.t, true)} pointer off the elements`
    case 'select': return e.ids.length ? `${clock(e.t, true)} selected ${names}` : `${clock(e.t, true)} selection cleared`
    case 'add': return `${clock(e.t, true)} drew ${names}`
    case 'edit': return `${clock(e.t, true)} changed ${names}`
    case 'delete': return `${clock(e.t, true)} removed ${names}`
  }
}

export interface DetailQuery {
  /** 1-based, as the overview numbers them; default the newest. */
  take?: number
  part?: number
  /** Seconds from the start of the take. */
  from?: number
  to?: number
}

/** The fine view of one part or time span of one take; null when that take or part does not exist. */
export function narrationDetail(takes: readonly NarrationTake[], labels: ReadonlyMap<string, string>, q: DetailQuery): string | null {
  const ordered = orderedTakes(takes)
  const n = q.take ?? ordered.length
  const take = ordered[n - 1]
  if (!take) return null
  const sentences = alignTake(take, labels)
  const parts = partsOf(sentences)
  let from: number
  let to: number
  let head: string
  if (q.part !== undefined) {
    const p = parts[q.part - 1]
    if (!p) return null
    from = p.t0
    to = p.t1
    head = `take ${n}, part ${p.n} (${clock(from)}-${clock(to)})`
  } else {
    from = q.from !== undefined ? q.from * 1000 : 0
    to = q.to !== undefined ? q.to * 1000 : Math.max(take.durationMs, ...sentences.map((s) => s.t1))
    head = `take ${n}, ${clock(from)}-${clock(to)}`
  }
  const takeEnd = takeEndOf(take)
  const all = new Map<string, string>([...eventLabels(take.events), ...labels])
  const lines = [head]
  for (const s of sentences) {
    if (s.t1 < from || s.t0 > to) continue
    lines.push(`${clock(s.t0, true)}-${clock(s.t1, true)} ${s.text ? quote(s.text) : '(not transcribed)'}`)
    lines.push(s.about.length ? `    about: ${s.about.map((m) => `${m.label} (${m.id}): ${m.why.join('; ')}`).join(' | ')}` : '    about: no element in particular')
  }
  const events = take.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.t >= from - POINT_LEAD_MS && e.t <= to)
  if (events.length) lines.push('events')
  for (const { e, i } of events.slice(0, DETAIL_LINES_MAX)) lines.push(`  ${eventLine(e, take.events, i, takeEnd, all)}`)
  if (events.length > DETAIL_LINES_MAX) lines.push(`  (${events.length - DETAIL_LINES_MAX} more events: ask for a shorter from/to)`)
  return lines.join('\n')
}
