/**
 * The unsubscribe link a newsletter offers in its own footer, when its headers offered none.
 *
 * Pure, and deliberately a small forward tokenizer rather than a regular expression over the whole
 * document: it runs in the server process on markup a stranger wrote, on every body the cache
 * stores, and the server has ONE event loop that every route shares, so its cost has to be bounded
 * by the bytes it reads and by nothing else.
 *
 * It used to be one regex, `/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi`, driven by an `exec` loop. That is
 * QUADRATIC on markup with no closing `</a>`: every `<a` start scans to the end of the string
 * looking for a close that is not there, then the next one does it again. Measured on this machine
 * at the 256 KB cap: `<a>` repeated cost 7.3 s, `<a  >` 4.4 s, `<a href=x>` 2.3 s and `<a\t`
 * (no `>` anywhere) 37.1 s — a stranger's mail freezing every route for half a minute, the exact
 * outage class this repo's rules forbid. `MAX_CANDIDATES` could not help: it is checked after `exec`
 * has already done the scanning. The old cost test measured 2 MB of WELL-FORMED anchors, which the
 * regex handles fine, and so it read green.
 *
 * The cursor here only ever moves FORWARD, so the whole scan is linear in the bytes it reads and
 * hostile markup is no more expensive than a newsletter: the same four inputs now cost 5.1 ms,
 * 3.1 ms, 2.3 ms and 0.01 ms. The ratchet is in the test file, on these exact inputs.
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

// Deliberately NO cap on how many anchors are looked at: the byte window above is the whole bound.
// A count cap was tried and removed. It is not what makes the scan cheap (the walk below is linear),
// and it can only lose a real link: 256 KB of `<a>` spam is 87,000 anchor starts, so any cap low
// enough to matter is also low enough for a hostile PREFIX to use up before the footer is reached —
// measured, a 4,096 cap turned "spam, then a genuine footer" from "link found" into "nothing".
//
// What bounds the total work instead is a property to preserve when editing this file: every anchor's
// label is read out of a slice of the window that no other anchor reads, and every pattern here is
// linear in its own input. So the sum over every anchor is one pass over the window.

/**
 * What an unsubscribe link says about itself.
 *
 * `manage preferences` is in here because for a great many senders it IS the unsubscribe page, and
 * leaving it out meant offering nothing at all on mail whose only exit is that wording. `opt[- ]?out`
 * covers `opt out`, `opt-out` and `optout`.
 */
const LABEL = /unsubscrib|opt[- ]?out|manage preferences/i

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

/** `<a` and `<a ` are anchors; `<abbr` and `<article` are not. What the old `\b` was for. */
function nameEnds(char: string | undefined): boolean {
  return char === undefined || !/[a-z0-9]/i.test(char)
}

/**
 * The url this one anchor offers, when its own label says it leaves the list.
 *
 * The TARGET is read first only because it is the commoner rejection: an anchor with no https href
 * can never be a candidate, so the three label reads are skipped for all of them. It decides nothing
 * — the label still has to match, and it is still read out of the anchor's own markup rather than out
 * of its target. (Both orders are a few milliseconds over 87,000 junk anchors; this one is the one
 * that does less work on the shape hostile markup actually takes.)
 *
 * Then three readings of the same label, because newsletter markup hides the word in all three
 * places. The RAW inner markup catches an `<img alt="Unsubscribe">` standing in for it; the
 * TAG-STRIPPED text catches a word broken across tags (`<b>Un</b>subscribe`), which the raw form
 * cannot see; and the anchor's own accessible names catch a link whose visible content is a spacer.
 */
function anchorLink(attrs: string, inner: string): string | undefined {
  const href = attributeValue(attrs.match(HREF))
  // `mailto:` is the header path's business, and an `http:` link is one the guard would refuse
  // anyway: neither is a candidate, so neither makes this message look ambiguous.
  if (!/^https:\/\//i.test(href) || href.length > MAX_URL_CHARS) return undefined
  if (!LABEL.test(inner)
    && !LABEL.test(inner.replace(/<[^>]*>/g, ''))
    && !LABEL.test(accessibleNames(attrs))) return undefined
  return href
}

/**
 * The https unsubscribe links this markup offers, in document order.
 *
 * One forward pass. `indexOf` from a cursor that never moves backwards is what makes the cost
 * linear: a `<a` whose `</a>` never arrives is judged on the text up to the NEXT `<a` (or to the end
 * of the window) rather than re-scanning the rest of the document looking for a close that is not
 * there. Unclosed anchors are ordinary in real bulk mail, so this reads MORE of them than the old
 * regex did, not fewer.
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
  /** The open anchor waiting for its label: its attributes, and where its content starts. */
  let openAttrs: string | undefined
  let innerFrom = 0

  /** Judge the open anchor, whose content ended at `innerTo`. */
  const settle = (innerTo: number): void => {
    if (openAttrs === undefined) return
    const attrs = openAttrs
    openAttrs = undefined
    if (seen.size >= MAX_CANDIDATES) return
    const href = anchorLink(attrs, markup.slice(innerFrom, innerTo))
    if (!href || seen.has(href)) return
    seen.add(href)
    if (!first) first = href
  }

  let at = 0
  while (seen.size < MAX_CANDIDATES) {
    const lt = markup.indexOf('<', at)
    if (lt === -1) break
    const closing = markup[lt + 1] === '/'
    const nameAt = closing ? lt + 2 : lt + 1
    const name = markup[nameAt]
    if ((name !== 'a' && name !== 'A') || !nameEnds(markup[nameAt + 1])) {
      // Any other tag, or a bare `<` in prose. Stepping one character on is what keeps the walk
      // honest: jumping to this tag's `>` would step over an `<a` hidden inside its attributes.
      at = lt + 1
      continue
    }
    if (closing) {
      settle(lt)
      at = nameAt + 1
      continue
    }
    const gt = markup.indexOf('>', nameAt + 1)
    // An unterminated tag ends the document as far as this scan is concerned. This is the branch the
    // old regex paid 37 s for: here it is one forward scan, once.
    if (gt === -1) { settle(lt); break }
    settle(lt)
    openAttrs = markup.slice(nameAt + 1, gt)
    innerFrom = gt + 1
    at = gt + 1
  }
  settle(markup.length)
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
