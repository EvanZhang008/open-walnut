/**
 * doc-page.ts: a document an agent reads in parts (the answer policy, answer.ts).
 *
 * 2026-11-21, seven days of calls: skill_read answered up to 4.6 MB through the CLI (p95 32,500
 * characters), agent_memory_read up to 57,700 and note_read up to 20,000, while an agent's MCP
 * client keeps about 25,000 characters of one answer. A document is read whole when it fits; a
 * longer one comes in pages of DOC_PAGE_CHARS, by `offset` (characters into the text) or by
 * `section` (a Markdown heading), and each page names its headings and the call that goes on.
 *
 * Pure: no I/O.
 */
import { z } from 'zod'
import { cutMark, printedSize, textCost, type AnswerFit, type AnswerSurface } from './answer.js'

/**
 * `text` held to `max` characters: what is left out is said by Walnut's cut mark (answer.ts), so
 * a write can tell the shortened text from a whole one and refuse it.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = onCharStart(text, max)
  return `${text.slice(0, keep)}… ${cutMark(text.length - keep)}`
}

/**
 * The end of `text`: at most `max` characters, and at most its last `lines` lines. The cut mark comes first,
 * where the text was cut (a tail keeps the end, so the mark cannot end it).
 */
export function tailText(text: string, max: number, lines = Number.MAX_SAFE_INTEGER): string {
  let start = text.endsWith('\n') ? text.length - 1 : text.length
  for (let n = 0; n < lines; n++) {
    const nl = text.lastIndexOf('\n', start - 1)
    if (nl < 0) { start = -1; break }
    start = nl
  }
  const from = onCharStart(text, Math.max(start + 1, text.length - max, 0))
  return from > 0 ? `${cutMark(from)} …\n${text.slice(from)}` : text
}

/** A document read's optional part: where to start, or one section by its heading. */
export const DOC_PART_INPUT = {
  offset: z.number().int().min(0).optional().describe('Characters into the text to start from (a page\'s `next` gives it)'),
  section: z.string().min(1).max(200).optional().describe('Only the part under this Markdown heading (its title, or a part of it)'),
}

/** The call asked for a part of the document. */
export const askedPart = (args: Record<string, unknown>): boolean => typeof args.offset === 'number' || typeof args.section === 'string'

/**
 * A result already paged goes as it is: a part was asked for, so the handler paged it, for an
 * agent to the cap its answer is held to (the handler's `caller.answer`), else at DOC_PAGE_CHARS.
 */
export const pageOnce = (result: unknown, page: () => unknown): unknown => {
  // Walnut's own page only (pageAnswer's `shown` or `error`): a result's own `page` key is data.
  const own = (result as { page?: { shown?: unknown; error?: unknown } } | null)?.page
  return own && typeof own === 'object' && (typeof own.shown === 'string' || typeof own.error === 'string') ? result : page()
}

/** One page of a document for a caller whose answer has no cap (a person, server code), in characters of JSON. */
export const DOC_PAGE_CHARS = 17_000
/**
 * The cap of a document read's whole answer: the page plus its fields, its headings and its note.
 * An agent's page is what the rest of its answer leaves of this cap, or of its surface's when smaller.
 */
export const DOC_ANSWER_MAX_CHARS = 23_000
/** Headings a page lists, at most, and the longest title it shows. */
const SECTIONS_MAX = 50
const TITLE_MAX = 60
/** The smallest page, in the measure's unit. */
const PAGE_MIN = 200

/** A string's length in JSON text, without its quotes (answer.ts textCost); on the CLI surface, in UTF-8 bytes. */
export function jsonLength(s: string, surface: AnswerSurface = 'mcp'): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n += textCost(s.charCodeAt(i), surface)
  return n
}

export interface Heading { level: number; title: string; at: number }

/** The Markdown headings of `text` (ATX `#` lines outside fenced code), with their offsets. */
export function headingsOf(text: string): Heading[] {
  const out: Heading[] = []
  let fence: string | null = null
  let at = 0
  for (const line of text.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[1][0]
      else if (f[1][0] === fence) fence = null
    } else if (!fence) {
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (h) out.push({ level: h[1].length, title: h[2], at })
    }
    at += line.length + 1
  }
  return out
}

export interface DocPage {
  /** The text of this page. */
  text: string
  /** Where it starts and ends in the document, in characters, and the document's length. */
  offset: number
  end: number
  total: number
  /** The section asked for, as found. */
  section?: string
  /** Where the next page starts, when there is one. */
  next_offset?: number
  /** The document's headings (the top levels), so a caller can ask for one by name. */
  sections?: string[]
  /** About how many pages follow this one, at this page's size, in the section asked for (a page ends at a line's end). */
  after: number
}

/**
 * The top headings, short: the deepest levels whose headings number at most SECTIONS_MAX, and at
 * least the second level (a document is often one `#` title over its `##` sections), cut to
 * SECTIONS_MAX with a count of the rest.
 */
function sectionList(heads: Heading[]): string[] {
  let level = 1
  for (let l = 6; l >= 1; l--) {
    if (heads.filter((h) => h.level <= l).length <= SECTIONS_MAX) { level = l; break }
  }
  const shown = heads.filter((h) => h.level <= Math.max(2, level))
  // A heading names a section to ask for (pageOf reads a title cut here by its start), not text to store.
  const list = shown.slice(0, SECTIONS_MAX).map((h) => `${'#'.repeat(h.level)} ${h.title.length > TITLE_MAX ? `${h.title.slice(0, TITLE_MAX)}…` : h.title}`)
  return shown.length > SECTIONS_MAX ? [...list, `and ${shown.length - SECTIONS_MAX} more headings`] : list
}

/** Never split a surrogate pair: an index on its second half moves past it. */
export function onCharStart(s: string, i: number): number {
  const c = s.charCodeAt(i)
  return c >= 0xdc00 && c <= 0xdfff ? i + 1 : i
}

/**
 * The part of `text` asked for: the section under a heading (matched without case, a whole title
 * first, then a part of one), from `offset`, at most `max` characters of JSON (bytes of it on the
 * CLI surface), ending at a line's end when one is near. An unknown section answers `error` with
 * the headings there are.
 */
export function pageOf(
  text: string,
  opts: { offset?: number; section?: string; max?: number; surface?: AnswerSurface; heads?: Heading[] } = {},
): DocPage | { error: string; sections: string[] } {
  const max = Math.max(PAGE_MIN, opts.max ?? DOC_PAGE_CHARS)
  const cost = (i: number): number => textCost(text.charCodeAt(i), opts.surface)
  const heads = opts.heads ?? headingsOf(text)
  let from = 0
  let to = text.length
  let found: Heading | undefined
  if (typeof opts.section === 'string' && opts.section.trim()) {
    const want = opts.section.trim().replace(/^#+\s*/, '').replace(/…$/, '').toLowerCase()
    found = heads.find((h) => h.title.toLowerCase() === want) ?? heads.find((h) => h.title.toLowerCase().includes(want))
    if (!found) return { error: `No section "${opts.section}" in it.`, sections: sectionList(heads) }
    from = found.at
    const after = heads.find((h) => h.at > found!.at && h.level <= found!.level)
    to = after ? after.at : text.length
  }
  const start = onCharStart(text, Math.min(to, Math.max(from, from + Math.max(0, Math.floor(opts.offset ?? 0)))))
  // An offset with a section counts from the section's start; alone, from the document's.
  let end = start
  for (let used = 0; end < to && used + cost(end) <= max; end++) used += cost(end)
  if (end < to) {
    const nl = text.lastIndexOf('\n', end - 1)
    if (nl > start && end - nl < max / 4) end = nl + 1
    end = onCharStart(text, end)
  }
  return {
    text: text.slice(start, end),
    offset: start,
    end,
    total: text.length,
    after: Math.ceil((to - end) / Math.max(1, end - start)),
    ...(found ? { section: `${'#'.repeat(found.level)} ${found.title}` } : {}),
    ...(end < to ? { next_offset: found ? end - from : end } : {}),
    ...(heads.length ? { sections: sectionList(heads) } : {}),
  }
}

/** `obj` without a `page` key of its own (the answer's `page` is Walnut's). */
function withoutPage(obj: Record<string, unknown>): Record<string, unknown> {
  const { page: _own, ...rest } = obj
  return rest
}

/** Set `value` at a dotted `path` of a copy of `root` (only the objects on the path are copied). */
function withAt(root: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = path
  if (!rest.length) return { ...root, [key]: value }
  const child = root[key] && typeof root[key] === 'object' ? root[key] as Record<string, unknown> : {}
  return { ...root, [key]: withAt(child, rest, value) }
}

function textAt(root: unknown, path: string[]): string | undefined {
  let cur: unknown = root
  for (const key of path) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined
  return typeof cur === 'string' ? cur : undefined
}

/**
 * The line a page of a longer document ends with, inside its text: a caller that prints the text
 * still says where it goes on, and a write that sends a page back whole is refused by the
 * executor (answer.ts cutTextRefusal knows this line), as it would drop the rest of the document.
 */
export const PAGE_MARK = '[Walnut: this is part of a longer document'

/** True when `text` holds a page's closing line (board_edit checks its html with it). */
export function holdsPageMark(text: unknown): boolean {
  return typeof text === 'string' && text.includes(PAGE_MARK)
}

/**
 * What a whole write takes to prove it read the whole document: a part never carries it, so a
 * page sent back with `expectedHash` cannot pass the check and replace the whole note.
 */
const WHOLE_ONLY_KEYS = new Set(['contentHash', 'content_hash', 'hash', 'version', 'etag', 'expectedHash'])

/** `obj` without the whole-only keys, and whether it had any. */
function withoutWholeKeys(obj: Record<string, unknown>): { out: Record<string, unknown>; had: boolean } {
  let had = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (WHOLE_ONLY_KEYS.has(k)) had = true
    else out[k] = v
  }
  return { out, had }
}

/** The root and every object on `path` (the text's parent) without the whole-only keys. */
function partOnly(root: Record<string, unknown>, path: string[]): { out: Record<string, unknown>; had: boolean } {
  const top = withoutWholeKeys(root)
  if (path.length < 2) return top
  const [key, ...rest] = path
  const child = top.out[key]
  if (!child || typeof child !== 'object' || Array.isArray(child)) return top
  const inner = partOnly(child as Record<string, unknown>, rest)
  return { out: { ...top.out, [key]: inner.out }, had: top.had || inner.had }
}

/**
 * The document at `path` of a result, in pages: the page `args` asked for (offset, section), or the
 * first, with a `page` field saying where it is and the exact call (`again(args)`) that reads on.
 * A document that fits, asked for no part, is left as it is. `changeWith` names how to change the
 * document without sending it back whole.
 *
 * `fit` is the cap an agent's answer is held to (answer.ts answerFit): the whole answer, printed as
 * its surface prints it, fits it, so no later cut can shorten the page and make its "read on"
 * offset skip text. Without one (a person, server code) a page is DOC_PAGE_CHARS of text.
 */
export function pagedResult(
  result: unknown, path: string, args: Record<string, unknown>, again: (more: Record<string, unknown>) => string,
  opts: { fit?: AnswerFit; changeWith?: string } = {},
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const keys = path.split('.')
  const text = textAt(result, keys)
  if (text === undefined) return result
  const asked = typeof args.offset === 'number' || typeof args.section === 'string'
  const fit = opts.fit
  if (!asked && (fit ? text.length <= fit.max && jsonLength(text, fit.surface) <= fit.max && printedSize(result, fit.surface) <= fit.max : jsonLength(text) <= DOC_PAGE_CHARS)) return result
  const heads = headingsOf(text)
  const build = (max: number) => pageAnswer(result as Record<string, unknown>, keys, text, heads, args, again, max, fit?.surface, opts.changeWith)
  if (!fit) return build(DOC_PAGE_CHARS).answer
  // The page gets what the rest of the answer leaves of the cap: each try that prints over gives
  // the next a page shorter than its own text by what it was over (a page ends at a line's end, so
  // a cap only a little lower may end it at the same place).
  let max = fit.max
  let out = build(max)
  for (let round = 0; round < 8; round++) {
    const over = printedSize(out.answer, fit.surface) - fit.max
    if (over <= 0 || max <= PAGE_MIN) return out.answer
    max = Math.max(PAGE_MIN, Math.min(max, out.used) - over - 40)
    out = build(max)
  }
  return out.answer
}

/** The answer of one page of `text` of at most `max` (pagedResult), and what its text took of that `max`. */
function pageAnswer(
  result: Record<string, unknown>, keys: string[], text: string, heads: Heading[], args: Record<string, unknown>,
  again: (more: Record<string, unknown>) => string, max: number, surface: AnswerSurface | undefined, changeWith: string | undefined,
): { answer: unknown; used: number } {
  const asked = typeof args.offset === 'number' || typeof args.section === 'string'
  const page = pageOf(text, { offset: typeof args.offset === 'number' ? args.offset : undefined, section: typeof args.section === 'string' ? args.section : undefined, max, surface, heads })
  if ('error' in page) return { answer: withAt({ page: { error: page.error, sections: page.sections }, ...withoutPage(partOnly(result, keys).out) }, keys, ''), used: 0 }
  const section = page.section ? { section: page.section } : {}
  const next = page.next_offset !== undefined ? again({ ...section, offset: page.next_offset }) : undefined
  const whole = page.offset === 0 && page.end === page.total
  const shown = `characters ${page.offset} to ${page.end} of ${page.total}${page.section ? `, in section ${page.section}` : ''}`
  const change = changeWith ? ` To change it use ${changeWith}; never write this part back whole.` : ''
  const mark = whole ? '' : `\n\n${PAGE_MARK}: ${shown}.${next ? ` Read on: ${next}.` : ''}${change}]\n`
  // A part carries no hash or version: a write that needs one reads the whole first.
  const part = whole ? { out: result, had: false } : partOnly(result, keys)
  // Walnut's `page` is the one the answer carries, never a result's own key of that name.
  const rest = withoutPage(part.out)
  const of = page.section ? ' of that section' : ''
  // The first page of what was asked: the document's start, or a section's (an offset there counts from it).
  const first = page.section ? !(typeof args.offset === 'number' && args.offset >= 1) : page.offset === 0
  const more = `about ${page.after} more part${page.after === 1 ? '' : 's'} follow${page.after === 1 ? 's' : ''}`
  // `page` comes first, its first line saying this is a part: a reader that stops after the text's
  // first lines (a shell's head, a skim) still knows there is more and how to read it.
  const answer = withAt({
    page: {
      ...(whole ? {} : {
        part: next
          ? `${first ? `Part 1 of about ${page.after + 1}${of}` : `A later part${of}, ${more}`}: NOT the whole text. Read on with \`next\`.`
          : first ? `The whole${of}.` : `The last part${of}.`,
      }),
      shown: `${shown[0].toUpperCase()}${shown.slice(1)}.`,
      ...(next ? { next } : { next: page.section ? 'This is the end of that section.' : 'This is the end of it.' }),
      ...(part.had ? { hash: 'Left out of a part: a whole write (expectedHash) needs the hash of a whole read ("_full": true).' } : {}),
      ...(page.sections && !asked ? { sections: page.sections, by_section: again({ section: '<a heading above>' }) } : {}),
    },
    ...rest,
  }, keys, `${page.text}${mark}`)
  return { answer, used: jsonLength(page.text, surface) }
}
