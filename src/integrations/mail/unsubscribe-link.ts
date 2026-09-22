/**
 * The unsubscribe link a newsletter offers in its own footer, when its headers offered none.
 *
 * Pure, and deliberately a set of bounded regular expressions rather than a parser: it runs in the
 * server process on markup a stranger wrote, on every body the cache stores, so it must not be able
 * to execute, fetch, recurse or take more than a moment. Measured against a 2 MB newsletter it is
 * the scan cap below that keeps it at well under a millisecond.
 *
 * Three rules it encodes, each of which is the difference between a useful answer and a wrong one:
 *
 * - ONLY WHAT THE SERVER COULD ACTUALLY FETCH COUNTS. A `mailto:` in the footer is not a candidate:
 *   the header path owns mailto (it has the RFC's own field for it), and counting one here would
 *   make `bodyCandidates` say "ambiguous" about a link this module never hands over.
 * - THE VISIBLE LABEL DECIDES, NOT THE URL. The href is an opaque tracking token the sender chose,
 *   and a word inside it is not a promise about where it goes; the text (or the `alt` of the image
 *   standing in for it) is what a human would have clicked. So the label test runs over the anchor's
 *   own markup and its accessible names, never over its target.
 * - MORE THAN ONE ANSWER IS A QUESTION FOR A HUMAN. `bodyCandidates > 1` is what lets the console
 *   say "this one is ambiguous" instead of picking a link and hoping.
 */
import type { StoredListUnsubscribe } from './service-dto.js'

/**
 * How much markup is looked at. A newsletter's footer is at the end, but so is a megabyte of
 * base64 inline imagery, and the cost of scanning all of it is paid on every body the cache stores.
 * The same 256 KB the verdict reader uses, for the same reason.
 */
export const LINK_SCAN_BYTES = 256 * 1024

/** The same per-url cap the `List-Unsubscribe` header path applies. */
const MAX_URL_CHARS = 2048

/** Distinct urls kept before the scan gives up: past this the answer is "ambiguous" either way. */
const MAX_CANDIDATES = 8

/**
 * What an unsubscribe link says about itself.
 *
 * `manage preferences` is in here because for a great many senders it IS the unsubscribe page, and
 * leaving it out meant offering nothing at all on mail whose only exit is that wording. `opt[- ]?out`
 * covers `opt out`, `opt-out` and `optout`.
 */
const LABEL = /unsubscrib|opt[- ]?out|manage preferences/i

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
const ACCESSIBLE_NAME = /\b(?:title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

export interface UnsubscribeLinkFind {
  /** The first https link whose label says it leaves the list. Absent when there was none. */
  link?: string
  /** How many DISTINCT such links the markup offers. More than one means "ask a human". */
  candidates: number
}

function attributeValue(match: RegExpMatchArray | null): string {
  if (!match) return ''
  return (match[1] ?? match[2] ?? match[3] ?? '').trim()
}

function accessibleNames(attrs: string): string {
  ACCESSIBLE_NAME.lastIndex = 0
  const out: string[] = []
  let found: RegExpExecArray | null
  while ((found = ACCESSIBLE_NAME.exec(attrs)) !== null) {
    out.push(found[1] ?? found[2] ?? found[3] ?? '')
  }
  return out.join(' ')
}

/**
 * The https unsubscribe links this markup offers, in document order.
 *
 * Case-insensitive on the scheme because `HTTPS://` is legal and a sender wrote this string. The
 * url is otherwise handed over exactly as it appeared: the SSRF guard is the thing that decides
 * whether it may be fetched, and normalising it here would only move that decision somewhere it
 * cannot be graded.
 */
export function extractUnsubscribeLink(html: string): UnsubscribeLinkFind {
  const markup = html.length > LINK_SCAN_BYTES ? html.slice(0, LINK_SCAN_BYTES) : html
  const seen = new Set<string>()
  let first: string | undefined
  ANCHOR.lastIndex = 0
  let anchor: RegExpExecArray | null
  while ((anchor = ANCHOR.exec(markup)) !== null) {
    if (seen.size >= MAX_CANDIDATES) break
    const attrs = anchor[1] ?? ''
    const inner = anchor[2] ?? ''
    // Three readings of the same label, because newsletter markup hides the word in all three places.
    // The RAW inner markup catches an `<img alt="Unsubscribe">` standing in for it; the TAG-STRIPPED
    // text catches a word broken across tags (`<b>Un</b>subscribe`), which the raw form cannot see;
    // and the anchor's own accessible names catch a link whose visible content is a spacer.
    if (!LABEL.test(inner)
      && !LABEL.test(inner.replace(/<[^>]*>/g, ''))
      && !LABEL.test(accessibleNames(attrs))) continue
    const href = attributeValue(attrs.match(HREF))
    // `mailto:` is the header path's business, and an `http:` link is one the guard would refuse
    // anyway: neither is a candidate, so neither makes this message look ambiguous.
    if (!/^https:\/\//i.test(href) || href.length > MAX_URL_CHARS) continue
    if (seen.has(href)) continue
    seen.add(href)
    if (!first) first = href
  }
  return { ...(first ? { link: first } : {}), candidates: seen.size }
}

/**
 * What to store about leaving this list once the body's bytes are on disk.
 *
 * Runs ONLY when the headers offered no url at all. A message whose `List-Unsubscribe` named an
 * https or mailto target already has the sender's own answer, and scraping its markup for a second
 * one would cost the scan on every stored body to produce a field nothing reads (the availability
 * ladder prefers the headers) — while also inviting the two to disagree.
 *
 * A capture that holds only a `List-Id` DOES get scanned: a list key is not a way out of the list.
 */
export function unsubscribeFromBodyHtml(
  held: StoredListUnsubscribe | undefined,
  html: string | undefined,
): StoredListUnsubscribe | undefined {
  if (held?.https?.length || held?.mailto?.length) return held
  if (!html) return held
  const found = extractUnsubscribeLink(html)
  if (!found.link) return held
  // `oneClick` first so it is present even when nothing was held; anything held wins over it,
  // because that value came from the sender's own headers.
  return { oneClick: false, ...(held ?? {}), bodyLink: found.link, bodyCandidates: found.candidates }
}
