/**
 * A browser answer, framed: what the page showed reaches an agent only inside a frame.
 *
 * A web page is written by whoever runs the site, and so is everything an action reads off it: its
 * text, the snapshot's names, a find's matches, a form's values, a dialog's message, the tab's
 * title, a response body, a console line. The browser op's answer also quotes those in its own
 * `outcome` line ("went to <url> "<title>"", "It opened a confirm: "<message>""), so the frame
 * takes the answer whole and leaves outside only Walnut's own control fields and the ids an agent
 * acts with, each checked against its shape (a field that fails its check goes inside). A field a
 * newer extension adds is inside by default.
 *
 * Two forms of the same frame, by who reads the answer (src/ops/browser.ts picks):
 * - `framePageAnswer`: one `external_content` envelope, for an agent on any surface (MCP, `walnut
 *   tools call`): the answer cap then shortens the page's data, never a frame. The page's address
 *   rides as the frame's `url`.
 * - `framePageFields`: the answer's own shape, each page string replaced by a text frame in the
 *   same place, for a program with no cap that prints it: the `walnut browser` command on every host. A CLI
 *   bundled in a daemon from before the frame reads the fields where it always did and so prints
 *   the page framed (2026-11-26 review M6: given the envelope it printed an empty line, and a failed
 *   `--read` exited 0). The current CLI takes the frames off (readPageAnswer) and frames what it
 *   prints once.
 *
 * Not framed: an answer that asks the person first (`status: needs_ok`), which is Walnut's own ask,
 * and an envelope this process built already (isWalnutFramed, never a test of the content).
 */
import { frameOutsideData, frameOutsideText, isFramedOutside, isWalnutFramed, outsideDataOf, type OutsideSource } from '../outside-content.js'

export const PAGE_SOURCE = 'web page'

const WORD = /^[a-z][a-z0-9_]{0,59}$/

/** An element ref (e12, f3:e12): an id the extension made, no words in it. */
const REF = /^(f\d+:)?e\d+$/

/** The fields that stay outside the frame, each with the shape it must have to stay there. */
export const OUTSIDE_PAGE_FRAME: Readonly<Record<string, (value: unknown) => boolean>> = {
  ok: (v) => typeof v === 'boolean',
  status: (v) => typeof v === 'string' && WORD.test(v),
  code: (v) => typeof v === 'string' && WORD.test(v),
  /** An ask's id, sent again with the next call. */
  request: (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v),
  tab: (v) => typeof v === 'number' && Number.isInteger(v),
  /** Walnut's own next step (browser op outcomeOf): it never quotes the page. */
  next: (v) => typeof v === 'string',
  /** An inline picture, bytes and not words; the CLI saves it as a file. */
  image: (v) => typeof v === 'string' && /^data:image\/[a-z+.-]{1,20};base64,[A-Za-z0-9+/=]*$/.test(v),
}

function pageSource(answer: Record<string, unknown>): OutsideSource {
  const url = typeof answer.url === 'string' && answer.url ? answer.url.slice(0, 2_000) : undefined
  return { source: PAGE_SOURCE, ...(url ? { attrs: { url } } : {}) }
}

/** The answer split into Walnut's own fields and the page's; undefined when nothing is framed. */
function splitAnswer(answer: Record<string, unknown>): { own: Record<string, unknown>; page: Record<string, unknown> } | undefined {
  if (answer.status === 'needs_ok' || isWalnutFramed(answer)) return undefined
  const own: Record<string, unknown> = {}
  const page: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(answer)) {
    if (OUTSIDE_PAGE_FRAME[key]?.(value)) own[key] = value
    else page[key] = value
  }
  return Object.keys(page).length ? { own, page } : undefined
}

/** The answer with what the page showed inside one envelope; Walnut's fields and the ids outside. */
export function framePageAnswer(answer: Record<string, unknown>): Record<string, unknown> {
  const split = splitAnswer(answer)
  return split ? { ...split.own, ...frameOutsideData(pageSource(answer), split.page) } : answer
}

/** A text frame carries only the source: the address is a page field, framed where it sits. */
const IN_PLACE: OutsideSource = { source: PAGE_SOURCE }
const BODY = 'PAGE_FRAME_BODY'
const [FRAME_HEAD, FRAME_TAIL] = frameOutsideText(IN_PLACE, BODY).split(BODY) as [string, string]

/** A key Walnut's extension writes; any other (a page's own object, from evaluate) frames its object whole. */
const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/
const MAX_DEPTH = 12

function frameInPlace(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return REF.test(value) ? value : frameOutsideText(IN_PLACE, value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? frameOutsideText(IN_PLACE, JSON.stringify(value)) : value.map((v) => frameInPlace(v, depth + 1))
  const entries = Object.entries(value as Record<string, unknown>)
  if (depth >= MAX_DEPTH || entries.some(([k]) => !FIELD_KEY.test(k))) return frameOutsideText(IN_PLACE, JSON.stringify(value))
  return Object.fromEntries(entries.map(([k, v]) => [k, frameInPlace(v, depth + 1)]))
}

/**
 * Walnut's own words nested in a page field that an older CLI acts on, each kept plain when it has its
 * top-level shape (OUTSIDE_PAGE_FRAME): a failed `--read`'s `page_text.code` picks its exit code
 * (browser-cli.ts exitOf), so framed it exited with the generic error (2026-11-26 review).
 */
const NESTED_OWN: Readonly<Record<string, readonly string[]>> = { page_text: ['code', 'status'] }

function frameField(key: string, value: unknown): unknown {
  const own = NESTED_OWN[key]
  if (!own || value === null || typeof value !== 'object' || Array.isArray(value)) return frameInPlace(value, 1)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([k]) => !FIELD_KEY.test(k))) return frameInPlace(value, 1)
  return Object.fromEntries(entries.map(([k, v]) => [k, own.includes(k) && OUTSIDE_PAGE_FRAME[k]?.(v) ? v : frameInPlace(v, 2)]))
}

/** The answer in its own shape, each page string a text frame where it was; Walnut's fields as they are. */
export function framePageFields(answer: Record<string, unknown>): Record<string, unknown> {
  const split = splitAnswer(answer)
  if (!split) return answer
  const page = Object.fromEntries(Object.entries(split.page).map(([k, v]) => [k, frameField(k, v)]))
  return { ...split.own, ...page }
}

/** A string framed in place, its text; else undefined. Exact: the text cannot close its own frame (its tag is escaped). */
function unframed(value: string): string | undefined {
  if (value.length < FRAME_HEAD.length + FRAME_TAIL.length || !value.startsWith(FRAME_HEAD) || !value.endsWith(FRAME_TAIL)) return undefined
  return value.slice(FRAME_HEAD.length, value.length - FRAME_TAIL.length)
}

function unframeAll(value: unknown, found: { any: boolean }, depth = 0): unknown {
  if (typeof value === 'string') {
    const text = unframed(value)
    if (text === undefined) return value
    found.any = true
    return text
  }
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((v) => unframeAll(v, found, depth + 1))
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, unframeAll(v, found, depth + 1)]))
}

/**
 * A browser answer read back by Walnut's own code that prints it (the `walnut browser` CLI): its fields
 * with the frames taken off, and the frame to print the page's words in, when it had one. Reads both
 * forms; the CLI frames everything it prints from it (framePageText).
 */
export function readPageAnswer(answer: Record<string, unknown>): { fields: Record<string, unknown>; from?: OutsideSource } {
  if (isFramedOutside(answer)) {
    const { external_content: _env, note: _note, ...own } = answer
    const data = outsideDataOf(answer)
    const fields = { ...(data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}), ...own }
    return { fields, from: pageSource(fields) }
  }
  const found = { any: false }
  const fields = unframeAll(answer, found) as Record<string, unknown>
  return found.any ? { fields, from: pageSource(fields) } : { fields }
}

/** Text Walnut printed from a framed answer, in the text form of the same frame. */
export function framePageText(from: OutsideSource | undefined, text: string): string {
  return from ? frameOutsideText(from, text) : text
}
