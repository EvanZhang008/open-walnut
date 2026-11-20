/**
 * The words of the topics mail bridge: the subject, the body, and reading a reply back.
 * Pure functions, so every rule here is tested on its own.
 */

export const TOPIC_MAIL_FOOTER = 'Reply to this email to post in the topic. Mention @Name to call someone.'

/** The longest text one inbound mail may post; the rest is cut with a note. */
export const MAX_INBOUND_CHARS = 8_000

export function topicMailSubject(title: string, topicId: string): string {
  const clean = title.replace(/[\r\n]+/g, ' ').trim() || 'Topic'
  return `${clean} [topic ${topicId}]`
}

/** The body of one outbound mail: each new message as "Name: text", then the footer. */
export function topicMailBody(lines: ReadonlyArray<{ name: string; text: string }>): string {
  // A blank line between messages, so the html half (rendered from this text) keeps them apart.
  const blocks = lines.map((line) => `${line.name}: ${line.text.trim()}`)
  return `${blocks.join('\n\n')}\n\n${TOPIC_MAIL_FOOTER}\n`
}

/** The bare address of "Name <a@example.com>" or "a@example.com", lower case. */
export function bareAddress(value: string): string {
  const raw = (value ?? '').trim()
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(raw)
  return (angled ? angled[1]! : raw).trim().toLowerCase()
}

/** A Message-ID in its canonical `<id@host>` form, or '' when it is not one. */
export function canonicalMessageId(value: string | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return ''
  const inner = raw.replace(/^<|>$/g, '').trim()
  if (!inner || /[\s<>]/.test(inner) || !inner.includes('@')) return ''
  return `<${inner}>`
}

const WROTE_LINE = /^on\b.{0,300}\bwrote:\s*$/i
const ORIGINAL_MESSAGE = /^-{2,}\s*original message\s*-{2,}\s*$/i
const OUTLOOK_RULE = /^_{10,}\s*$/
const HEADER_FROM = /^\*?from:\*?\s+\S/i
const HEADER_SENT = /^\*?(sent|date):\*?\s+\S/i
const SIGNATURE = /^--\s?$/
const MOBILE_SIGNATURE = /^sent from my \S/i

/** Whether the quoted part of a reply starts at line `at`. */
function quoteStartsAt(lines: string[], at: number): boolean {
  const line = lines[at]!.trim()
  if (WROTE_LINE.test(line)) return true
  // Gmail wraps a long attribution: "On Mon, ... Name <a@example.com>" / "wrote:".
  const next = (lines[at + 1] ?? '').trim()
  if (/^on\s/i.test(line) && line.length < 300 && next.length < 160 && /\bwrote:\s*$/i.test(next)) return true
  if (ORIGINAL_MESSAGE.test(line)) return true
  if (OUTLOOK_RULE.test(line)) {
    const following = lines.slice(at + 1).find((one) => one.trim() !== '')
    if (following && HEADER_FROM.test(following.trim())) return true
  }
  // Outlook's header block: From: / Sent: (or Date:) / To: / Subject:.
  if (HEADER_FROM.test(line)) {
    for (let k = at + 1; k <= at + 4 && k < lines.length; k++) {
      if (HEADER_SENT.test(lines[k]!.trim())) return true
    }
  }
  return false
}

/**
 * The person's own words of a reply: quoted lines (">"), the "On ... wrote:" block and an
 * Outlook header block with everything after it, and a signature after "-- " are dropped.
 */
export function stripQuotedReply(text: string): string {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!
    if (quoteStartsAt(lines, at)) break
    if (SIGNATURE.test(line) || MOBILE_SIGNATURE.test(line.trim())) break
    if (/^\s*>/.test(line)) continue
    kept.push(line.replace(/\s+$/, ''))
  }
  const joined = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (joined.length <= MAX_INBOUND_CHARS) return joined
  return `${joined.slice(0, MAX_INBOUND_CHARS)}\n[cut: the mail was longer]`
}
