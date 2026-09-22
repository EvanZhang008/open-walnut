/**
 * A `mailto:` unsubscribe target, turned into the ONE mail Walnut is willing to send.
 *
 * Pure, and deliberately the narrowest reading of RFC 6068 that still works on real lists: this is the
 * only rung of the ladder that puts a message on the wire under the person's own name, so every branch
 * here is either "one recipient, one subject, one line of body" or a refusal with a reason.
 *
 * What it refuses, and why each refusal is a real mail somebody would otherwise have sent:
 *
 * - MORE THAN ONE RECIPIENT. `mailto:a@x,b@x` is legal in the RFC and means "mail both", and a list
 *   whose unsubscribe address is a pair is either a mistake or someone using the person's own mail
 *   server to reach an address they never chose. "Unsubscribe me" is one recipient, always. The `to`
 *   query field counts as well (`mailto:?to=u@x` is the RFC's other spelling of one recipient), and a
 *   `cc` or `bcc` is refused outright: there is no version of this mail that copies a third party.
 * - AN ADDRESS THAT IS NOT ONE. `mailto:`, `mailto:undisclosed-recipients:;` and
 *   `mailto:a%2Cb@x` are all real header values. The shape check is the SAME one `drafts.ts` applies
 *   before it will send (`ADDRESS_SHAPE`), so a target that fails here would have failed there, in a
 *   place the human cannot see, after the ledger already claimed the attempt.
 *
 * Two decisions that look like details and are not:
 *
 * - `+` IS A LITERAL PLUS, not a space. RFC 6068 gives it no special meaning, and the subject of an
 *   unsubscribe mail is usually a TOKEN identifying the subscriber. Reading `+` as a space the way a
 *   form body would corrupts exactly that token, so the list receives a mail it cannot match to
 *   anybody and the person stays subscribed with a green tick on their screen.
 * - COMMAS ARE SPLIT BEFORE DECODING. `%2C` decodes to a comma, and the RFC requires a comma inside an
 *   address to be encoded precisely so that splitting happens first. Splitting after would read
 *   `a%2Cb@x` as one address, and `ADDRESS_SHAPE` accepts a comma inside the local part, so that pair
 *   would have become a single recipient nobody wrote.
 */
import { ADDRESS_SHAPE } from './agent-format.js'

/** The word a list gets when it named no subject. Lowercase: it is a command, not a sentence. */
export const UNSUBSCRIBE_WORD = 'unsubscribe'

/** Caps on what the SENDER chose. Their header is not allowed to author a long mail in our name. */
export const UNSUBSCRIBE_MAILTO_SUBJECT_CHARS = 200
export const UNSUBSCRIBE_MAILTO_BODY_CHARS = 500

/** The mail, ready for `drafts.create`. One recipient, by construction. */
export interface UnsubscribeMailto {
  to: string
  subject: string
  body: string
}

/**
 * Why a target was refused, in the ledger's own vocabulary.
 *
 * Two values rather than one, because they need different sentences: an address Walnut cannot read is
 * a broken header, and a pair of addresses is a header Walnut read perfectly and will not obey.
 */
export type UnsubscribeMailtoRefusal = 'mailto-unusable' | 'mailto-many-recipients'

export type ParsedUnsubscribeMailto =
  | { ok: true; mail: UnsubscribeMailto }
  | { ok: false; reason: UnsubscribeMailtoRefusal; detail: string }

/** `%`-escapes, or the raw text when the sender wrote an escape that is not one. */
function safeDecode(value: string): string {
  try { return decodeURIComponent(value) }
  catch { return value }
}

/** One line, capped. A CR or an LF in a subject is header injection, so it goes. */
function subjectOf(raw: string | undefined): string {
  const decoded = safeDecode(raw ?? '').replace(/[\r\n]+/g, ' ').trim()
  return (decoded || UNSUBSCRIBE_WORD).slice(0, UNSUBSCRIBE_MAILTO_SUBJECT_CHARS)
}

/** The body. Line breaks are allowed here (it is a body) but normalised, and the whole is capped. */
function bodyOf(raw: string | undefined): string {
  const decoded = safeDecode(raw ?? '').replace(/\r\n?/g, '\n').trim()
  return (decoded || UNSUBSCRIBE_WORD).slice(0, UNSUBSCRIBE_MAILTO_BODY_CHARS)
}

/**
 * The recipients a raw address list names, split then decoded (see the header).
 *
 * An empty segment is dropped rather than counted: `mailto:u@x,` is one recipient and a trailing
 * comma, which is a typo in somebody's mail template and not a second person.
 */
function addressesIn(raw: string): string[] {
  return raw
    .split(',')
    .map((one) => safeDecode(one.trim()).trim())
    .filter((one) => one.length > 0)
}

/** The query as an ordered list of pairs. Keys lowercased; a repeat is kept, so it can be counted. */
function queryPairs(raw: string): Array<{ key: string; value: string }> {
  if (!raw) return []
  return raw.split('&').flatMap((part) => {
    if (!part) return []
    const at = part.indexOf('=')
    const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase()
    // A key that decodes to something else is not a header field name any list uses; the raw key is
    // what is matched, so `%73ubject` is simply an unknown field and is dropped with the rest.
    return key ? [{ key, value: at < 0 ? '' : part.slice(at + 1) }] : []
  })
}

/**
 * The two characters that MUST NOT survive into a recipient, whatever the shape check says.
 *
 * `ADDRESS_SHAPE` accepts both inside a local part (they are not `@` and not whitespace), and both are
 * address separators in the two grammars that matter, so a value carrying one is a list somebody
 * smuggled past the split.
 */
const ADDRESS_SEPARATORS = /[,;]/

/**
 * Read one `mailto:` unsubscribe target.
 *
 * Never throws: a bad target is an OUTCOME the ladder records with its reason, exactly like a page
 * that refused, because the alternative is a 500 for a newsletter whose header happens to be wrong.
 */
export function parseUnsubscribeMailto(target: string): ParsedUnsubscribeMailto {
  const raw = (target ?? '').trim()
  if (!/^mailto:/i.test(raw)) {
    return { ok: false, reason: 'mailto-unusable', detail: 'the unsubscribe target is not a mailto address' }
  }
  const rest = raw.slice('mailto:'.length)
  const split = rest.indexOf('?')
  const path = split < 0 ? rest : rest.slice(0, split)
  const pairs = queryPairs(split < 0 ? '' : rest.slice(split + 1))

  // A copy on an unsubscribe is never right, and it is refused before the recipients are even
  // counted: with `cc` dropped instead, a target naming one recipient and one cc would have sent a
  // mail the person never agreed to copy anybody on.
  if (pairs.some((one) => one.key === 'cc' || one.key === 'bcc')) {
    return {
      ok: false,
      reason: 'mailto-many-recipients',
      detail: 'this unsubscribe address copies other recipients, which Walnut will not send',
    }
  }

  const recipients = [
    ...addressesIn(path),
    ...pairs.filter((one) => one.key === 'to').flatMap((one) => addressesIn(one.value)),
  ]
  if (recipients.length === 0) {
    return { ok: false, reason: 'mailto-unusable', detail: 'the unsubscribe target names no address' }
  }
  if (recipients.length > 1) {
    return {
      ok: false,
      reason: 'mailto-many-recipients',
      detail: `this unsubscribe address names ${recipients.length} recipients, and "unsubscribe me" is one`,
    }
  }
  const to = recipients[0]!
  if (ADDRESS_SEPARATORS.test(to) || !ADDRESS_SHAPE.test(to)) {
    return {
      ok: false,
      reason: 'mailto-unusable',
      // The address is the sender's own text, so it is clipped before it goes near a log or a ledger.
      detail: `"${to.slice(0, 80)}" is not an address Walnut can send to`,
    }
  }
  // `subject` and `body` are taken ONCE, from the first of each: a header repeating them is choosing
  // for us, and the first is the one a mail client would have shown the person.
  return {
    ok: true,
    mail: {
      to,
      subject: subjectOf(pairs.find((one) => one.key === 'subject')?.value),
      body: bodyOf(pairs.find((one) => one.key === 'body')?.value),
    },
  }
}
