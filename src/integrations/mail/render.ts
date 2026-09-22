/**
 * Two renderings, both of a draft body, and they have opposite trust assumptions.
 *
 * - The OUTGOING mail's `text/html` alternative. The markdown is ours (a human typed it in the
 *   console, or an agent wrote it), so the job is fidelity: turn it into the HTML a mail client
 *   will show. It is still rendered through a locked-down markdown pipeline rather than a plain
 *   one, because "ours" is not the same as "safe": an agent-written body quotes mail somebody
 *   else sent, and a `<script>` or an `onclick=` that rode a quoted paragraph would be shipped
 *   to whoever we are writing to, over the user's own name.
 * - The APPROVAL LETTER. Here the body is the thing being INSPECTED, and the letter is the
 *   document the human's decision rests on, so nothing in the body may change the letter's
 *   shape. Every character of it is escaped and every line is quoted before it is placed, so a
 *   body containing `## Send anyway` or a stray `</blockquote>` cannot forge a heading, a fake
 *   recipient line or an instruction that looks like Walnut speaking.
 *
 * Why no HTML sanitizer here. This repo has no server-side sanitizer to reach for, and a
 * regex-based one over hostile input is a class of bug rather than a defence. So the allowlist
 * is STRUCTURAL: `marked` is configured to ESCAPE raw HTML instead of passing it through, which
 * means every tag in the output is one marked itself generated, and the only attacker-shaped
 * values left are link and image URLs, which are checked against a scheme list.
 */
import { Marked } from 'marked'
import type { MailAddress } from './types.js'

/** Schemes a rendered link or image may keep. Everything else becomes inert text. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeUrl(href: string): string | null {
  const trimmed = href.trim()
  // A relative or anchor target is meaningless in an email and could be a scheme in disguise
  // (`java\nscript:`), so only an absolute URL with an allowed scheme survives.
  try {
    const parsed = new URL(trimmed)
    return SAFE_SCHEMES.has(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

/**
 * The one markdown renderer the send path uses, built once.
 *
 * `html` returns the raw source ESCAPED, which is what makes the tag set an allowlist by
 * construction: nothing reaches the output that marked did not emit itself. `link` and `image`
 * drop a URL whose scheme is not on the list, keeping the visible text so the reader still sees
 * what was written.
 */
const outgoing = new Marked({
  gfm: true,
  breaks: true,
}).use({
  renderer: {
    html(token: { raw: string }): string {
      return escapeHtml(token.raw)
    },
    link(token: { href: string; title?: string | null; text: string }): string {
      const href = safeUrl(token.href)
      const text = escapeHtml(token.text)
      if (!href) return text
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<a href="${escapeHtml(href)}"${title}>${text}</a>`
    },
    image(token: { href: string; title?: string | null; text: string }): string {
      const src = safeUrl(token.href)
      const alt = escapeHtml(token.text ?? '')
      if (!src) return alt
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<img src="${escapeHtml(src)}" alt="${alt}"${title}>`
    },
  },
})

/**
 * The `text/html` alternative for an outgoing message.
 *
 * Synchronous by construction (`async: false`): this runs on the send path inside a request, and
 * marked's async mode exists for walker extensions this renderer does not use.
 *
 * MEASURED, because it is synchronous work on the one event loop every route shares: 1.4 ms for a
 * 10 KB body, 29 ms at 200 KB, and 6 ms for a pathological 50,000 raw tags. It runs ONCE per send,
 * from a stored draft a human wrote and approved, and the body is capped at `MAX_BODY_CHARS`
 * (200,000) in drafts.ts. The cap is what keeps 29 ms the WORST case rather than an average one, so
 * if that cap ever rises, re-measure before assuming this is still free.
 */
export function renderOutgoingHtml(bodyMarkdown: string): string {
  const html = outgoing.parse(bodyMarkdown, { async: false })
  return typeof html === 'string' ? html : ''
}

/** One address as a human reads it, with every part escaped for the letter's markdown. */
function addressLine(address: MailAddress): string {
  const name = address.name?.trim()
  const plain = name ? `${name} <${address.address}>` : address.address
  return escapeMarkdown(plain)
}

/**
 * Neutralize text that is about to be placed INSIDE a document we author.
 *
 * `<` and `&` go first because markdown passes raw HTML through, so an un-escaped body could put
 * a tag into the letter. Then two different escapes, and the split is the point:
 *
 * - INLINE, everywhere: the characters that carry structure mid-line. `[` and `]` are what a link
 *   needs, so escaping them is what stops one forming, and `(` `)` mean nothing without them.
 * - LINE START only: a heading, a bullet, a rule, an ordered list. These are escaped ONLY at the
 *   start of a line, because a hyphen or a full stop mid-sentence is punctuation, and escaping
 *   those everywhere turned `bob@example.invalid` into `bob@example\.invalid` in a letter whose
 *   entire job is to show the human the exact address the mail is going to.
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]~|])/g, '\\$1')
    .replace(/^(\s*)([#+=-])/gm, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])/gm, '$1$2\\$3')
}

/**
 * A body as a markdown blockquote, escaped first.
 *
 * EVERY line is prefixed, including the empty ones: a blank line ends a blockquote, so a body
 * with a paragraph break would otherwise close the quote and everything after it would read as
 * the letter's own words rather than as quoted draft content.
 */
export function quotedMarkdown(text: string): string {
  const lines = escapeMarkdown(text).split('\n')
  return lines.map((line) => (line.length > 0 ? `> ${line}` : '>')).join('\n')
}

export interface ApprovalLetterInput {
  accountAddress: string
  accountLabel: string
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  bodyMarkdown: string
  isReply: boolean
}

/** How much draft body rides the letter. Past this the human is reading, not deciding. */
const LETTER_BODY_MAX_CHARS = 8_000

/**
 * The approval letter, rendered FROM THE STORED ROW and from nothing else.
 *
 * The caller passes the row, never the request that created it: the human approves what is on
 * disk, so a request body that changed after the draft was written cannot change what the
 * letter says. The recipient lines come first because they are the part a mistake actually
 * costs something, and the last line states the contract in plain words: answering Send sends
 * exactly this.
 */
export function renderApprovalLetter(input: ApprovalLetterInput): { subject: string; markdown: string } {
  const body = input.bodyMarkdown.length > LETTER_BODY_MAX_CHARS
    ? `${input.bodyMarkdown.slice(0, LETTER_BODY_MAX_CHARS)}\n\n[...truncated for this letter; the draft holds the whole body]`
    : input.bodyMarkdown
  const lines = [
    `**From**: ${escapeMarkdown(input.accountLabel)} (${escapeMarkdown(input.accountAddress)})`,
    `**To**: ${input.to.map(addressLine).join(', ') || '(nobody)'}`,
    ...(input.cc.length ? [`**Cc**: ${input.cc.map(addressLine).join(', ')}`] : []),
    ...(input.bcc.length ? [`**Bcc**: ${input.bcc.map(addressLine).join(', ')}`] : []),
    `**Subject**: ${escapeMarkdown(input.subject) || '(no subject)'}`,
    '',
    quotedMarkdown(body),
    '',
    'Answering Send sends exactly this. Answering Edit puts the draft back in the Mail console,'
    + ' and answering Discard throws it away without sending anything.',
  ]
  return {
    subject: `${input.isReply ? 'Approve this reply' : 'Approve this message'}: ${input.subject || '(no subject)'}`,
    markdown: lines.join('\n'),
  }
}

/** How much of a list name or a subject rides a letter that is asking one short question. */
const UNSUBSCRIBE_NAME_CHARS = 200

/** How much of a url is shown. Long enough for a real unsubscribe token, short of a paragraph. */
const UNSUBSCRIBE_URL_CHARS = 600

export interface UnsubscribeLetterInput {
  /** Which of the person's accounts holds the message. */
  accountLabel: string
  sender: MailAddress
  subject: string
  /** What is being left: the sender's own `List-Id` when it published one, else its address. */
  listName: string
  /** True when `listName` came from `List-Id`. False means it is the sender, which is coarser. */
  byListId: boolean
  /** The best rung this message offers. */
  method: 'one-click' | 'mailto' | 'link'
  /** The page Walnut would open, when the chosen rung has one. */
  url?: string
  /** Where that link came from. `'body'` means the account gave Walnut no unsubscribe headers. */
  urlSource?: 'header' | 'body'
  /** The mail address the list takes an unsubscribe at, for the mailto rung. */
  mailto?: string
}

/**
 * A url placed in a document we author, kept exactly as it arrived.
 *
 * A fenced block rather than `escapeMarkdown`, because this is the one field the human may want to
 * copy and open: escaping would show them `https://x/u?a\_b`, which is not the link. Fencing is what
 * makes it inert, and the only way out of a fence is a line that opens or closes one, so backticks
 * and newlines go first. The sender wrote this string (it came off a `List-Unsubscribe` header or out
 * of their own markup), so it is treated as hostile even though it parsed as https.
 */
function fencedUrl(url: string): string {
  const flat = url.replace(/[`\r\n]/g, '').slice(0, UNSUBSCRIBE_URL_CHARS).trim()
  return flat ? `\`\`\`\n${flat}\n\`\`\`` : ''
}

/**
 * The letter that asks whether to leave a list. The AI rung, and the ONLY thing the agent's op does.
 *
 * Written so that the human can answer it without opening anything else, which means it has to say
 * three things: which mail this is, what Walnut will actually DO if they tap Unsubscribe, and what it
 * cannot do. The third one is not politeness — the rungs differ in how final they are, and a letter
 * that promised "you will be off the list" for a page nobody has read yet would be the same lie the
 * verdict heuristics exist to avoid.
 *
 * Every value from the sender (the name, the subject, the `List-Id`) goes through `escapeMarkdown`
 * first, for the same reason the approval letter's does: this document is what a decision rests on,
 * and a subject able to forge a heading in it could change what the person thinks they are agreeing
 * to. The url is the one exception and it is fenced instead (see `fencedUrl`).
 */
export function renderUnsubscribeLetter(
  input: UnsubscribeLetterInput,
): { subject: string; markdown: string } {
  const list = escapeMarkdown(input.listName.slice(0, UNSUBSCRIBE_NAME_CHARS))
  const what = input.byListId ? 'list' : 'sender'
  // One block, single-spaced: these four are a header the eye reads down, not four paragraphs.
  const header = [
    `**From**: ${addressLine(input.sender)}`,
    `**Subject**: ${escapeMarkdown(input.subject.slice(0, UNSUBSCRIBE_NAME_CHARS)) || '(no subject)'}`,
    `**Account**: ${escapeMarkdown(input.accountLabel)}`,
    `**${input.byListId ? 'List' : 'Sender'}**: ${list || '(unnamed)'}`,
  ].join('\n')

  const blocks: string[] = [header]
  if (input.method === 'one-click') {
    blocks.push(
      `This ${what} publishes a one-click unsubscribe, so answering Unsubscribe makes Walnut send`
      + ' one request and nothing else: no page to read, no confirmation, and the sender learns'
      + ' nothing about you beyond the link they already gave out.',
      fencedUrl(input.url ?? ''),
      'If their endpoint refuses, Walnut opens the same link as a page and reads what it says.',
    )
  } else if (input.method === 'link') {
    blocks.push(
      `Answering Unsubscribe makes Walnut open this ${what}'s unsubscribe page and read what came`
      + ' back. It can only report what that page says: a page that confirms you are off the list is'
      + ' final, and a page that wants a button pressed is not, in which case the answer comes back'
      + ' here with the link so you can finish it.',
      fencedUrl(input.url ?? ''),
      input.urlSource === 'body'
        ? 'That link came out of the message itself, because this account gives Walnut no unsubscribe'
          + ' headers to read. It is the only way out this message offers: there is no one-click'
          + ' request to make and no address to write to.'
        : '',
    )
  } else {
    blocks.push(
      `This ${what} only takes an unsubscribe by mail`
      + `${input.mailto ? `, to ${escapeMarkdown(input.mailto.slice(0, UNSUBSCRIBE_NAME_CHARS))}` : ''}.`
      + ' Answering Unsubscribe asks Walnut to write that mail from this account, which is a thing'
      + ' only you can authorise; Walnut never decides to send mail on its own.',
    )
  }

  blocks.push(
    'Walnut has done nothing yet: it asked instead, because leaving a list is yours to decide.'
    + ' Answering Not now changes nothing and leaves the mail where it is.',
  )
  return {
    subject: `Unsubscribe from ${input.listName.slice(0, UNSUBSCRIBE_NAME_CHARS) || 'this list'}?`,
    markdown: blocks.filter((block) => block !== '').join('\n\n'),
  }
}
