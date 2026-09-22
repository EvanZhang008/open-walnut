/**
 * What an unsubscribe page said, reduced to one word.
 *
 * Pure, so every judgement below is gradable without a socket: the caller hands over a status code,
 * a content type and the first 256 KB of what came back, and gets one of `done` / `needs-human` /
 * `failed` plus a reason and a short quote for the ledger.
 *
 * The shape of the problem: there is no standard for what an unsubscribe endpoint answers. RFC 8058
 * standardised the one-click POST and nothing about the page a GET lands on, so this is a reading of
 * prose written by whoever runs the list. Two rules follow from that, and both are about not lying:
 *
 * - NO SIGNAL IS NOT SUCCESS. A marketing homepage with a 200 means the link went somewhere and
 *   nothing happened. Calling that `done` would tell the human they had left a list that still has
 *   them on it, which is worse than telling them to look at the page themselves.
 * - A FORM IS NOT A FAILURE EITHER. A confirmation page is the sender doing the right thing; it is
 *   handed back with its url so a human (or the model they ask) can finish it.
 */
import { htmlToText } from './bodies.js'

/** How much of the response is ever read or judged. The reader aborts the rest of the download. */
export const UNSUBSCRIBE_BODY_CAP = 256 * 1024

/** How much of the page's own words are kept next to the ledger row. */
export const UNSUBSCRIBE_DETAIL_CHARS = 300

export type UnsubscribeVerdictStatus = 'done' | 'needs-human' | 'failed'

export interface UnsubscribeVerdict {
  status: UnsubscribeVerdictStatus
  /** Why, in the ledger's vocabulary: `confirm-form`, `unclear`, `http-403`, `unreachable`. */
  reason?: string
  /** A short quote of what the page said, for a human reading the ledger later. */
  detail?: string
}

/**
 * Wordings that mean it is done.
 *
 * Every one of them is the PAST tense or an explicit statement of the new state, which is what keeps
 * a confirmation page ("are you sure you want to unsubscribe?") out: the bare verb never matches.
 */
const DONE_WORDS =
  /unsubscrib(ed|e (was )?success)|you (have been|were|are) (now )?(removed|unsubscribed)|no longer (receive|be subscribed)|opted out|removed from (this|the) (list|mailing)|preferences (have been )?(updated|saved)/i

/** A form that is asking about this, rather than the site's search box or newsletter signup. */
const FORM_ASKS = /unsubscrib|opt.?out|confirm/i

/** Status codes where the endpoint itself said no. Each gets its own `http-<code>` reason. */
const REFUSED = new Set([400, 401, 403, 404, 405, 410, 429])

/**
 * Form blocks, bounded. An unclosed `<form>` is common in mail-grade markup, so a block runs to the
 * next `</form>` or to this many characters, whichever comes first: without the cap one broken tag
 * would make every page after it read as a confirmation form.
 */
const FORM_TAIL_CHARS = 4_000

function formBlocks(markup: string): string[] {
  const out: string[] = []
  const opens = /<form\b/gi
  let open: RegExpExecArray | null
  while ((open = opens.exec(markup)) !== null) {
    const rest = markup.slice(open.index, open.index + FORM_TAIL_CHARS)
    const close = rest.search(/<\/form\s*>/i)
    out.push(close < 0 ? rest : rest.slice(0, close))
    if (out.length >= 8) break
  }
  return out
}

/** The page's own words, collapsed, for the ledger. Never the markup: that is unreadable in a log. */
function quote(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim()
  return line ? line.slice(0, UNSUBSCRIBE_DETAIL_CHARS) : undefined
}

export interface UnsubscribeVerdictInput {
  status: number
  /** The RAW first 256 KB, exactly as it arrived: the form check needs the markup. */
  body?: string
  contentType?: string
}

export function unsubscribeVerdict(input: UnsubscribeVerdictInput): UnsubscribeVerdict {
  const { status } = input
  const markup = (input.body ?? '').slice(0, UNSUBSCRIBE_BODY_CAP)
  // Folded with the same extractor that feeds cache search, so the quote in the ledger reads like a
  // search hit rather than like a page source.
  const text = markup.includes('<') ? htmlToText(markup) : markup

  if (status >= 200 && status < 300) {
    if (DONE_WORDS.test(text)) return { status: 'done', ...(quote(text) ? { detail: quote(text) } : {}) }
    const asking = formBlocks(markup).find((block) => FORM_ASKS.test(block))
    if (asking) {
      return { status: 'needs-human', reason: 'confirm-form', ...(quote(text) ? { detail: quote(text) } : {}) }
    }
    return { status: 'needs-human', reason: 'unclear', ...(quote(text) ? { detail: quote(text) } : {}) }
  }

  if (REFUSED.has(status)) {
    return { status: 'failed', reason: `http-${status}`, ...(quote(text) ? { detail: quote(text) } : {}) }
  }
  if (status >= 500) {
    return { status: 'failed', reason: 'unreachable', detail: quote(text) ?? `the endpoint answered ${status}` }
  }
  if (status >= 300 && status < 400) {
    // Only reachable when a redirect arrived with no `Location` to follow: the hop loop handles the
    // ordinary case, so this is a broken endpoint rather than a redirect.
    return { status: 'failed', reason: 'unreachable', detail: `the endpoint answered ${status} with no location` }
  }
  return { status: 'failed', reason: `http-${status}`, ...(quote(text) ? { detail: quote(text) } : {}) }
}

/** One sentence a console can print verbatim for any outcome of the ladder. */
export function unsubscribeSentence(outcome: {
  status: 'done' | 'needs-human' | 'failed' | 'in-flight'
  method: string
  reason?: string
}): string {
  const how = outcome.method === 'one-click'
    ? 'the sender\'s one-click link'
    : outcome.method === 'mailto'
      ? 'a mail to the list'
      : outcome.method === 'link'
        ? 'the unsubscribe page'
        : 'this message'
  switch (outcome.status) {
    case 'done':
      return `Unsubscribed using ${how}.`
    case 'in-flight':
      return `Walnut is unsubscribing you using ${how}; the console updates itself when it lands.`
    case 'needs-human':
      if (outcome.reason === 'confirm-form') {
        return 'The unsubscribe page opened but it wants a confirmation, so nothing is final yet. Ask Walnut to finish it, or open the page yourself.'
      }
      if (outcome.reason === 'mailto-pending') {
        return 'This list only takes an unsubscribe by mail, which Walnut cannot send yet.'
      }
      return 'Walnut opened the unsubscribe page and could not tell whether it worked. Open the page to be sure.'
    case 'failed':
    default:
      if (outcome.reason?.startsWith('blocked-')) {
        return 'That unsubscribe link is not one Walnut is willing to open. Open it yourself if you trust the sender.'
      }
      if (outcome.reason === 'timeout') return 'The unsubscribe page did not answer in time. Nothing was changed.'
      if (outcome.reason === 'too-many-redirects') {
        return 'The unsubscribe link kept redirecting, so Walnut stopped. Nothing was changed.'
      }
      if (outcome.reason === 'unreachable') return 'The unsubscribe page could not be reached. Nothing was changed.'
      return `The unsubscribe page refused (${outcome.reason ?? 'no reason given'}). Nothing was changed.`
  }
}
