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
import type { LetterLang } from '../../core/human-inbox/walnut-letters/languages.js'
import { MAIL_APPROVAL, type ApprovalLetterInput } from '../../core/human-inbox/walnut-letters/mail-approval.js'
import { MAIL_UNSUBSCRIBE, type UnsubscribeLetterInput } from '../../core/human-inbox/walnut-letters/mail-unsubscribe.js'

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

export { escapeMarkdown, quotedMarkdown } from './letter-markdown.js'
export type { ApprovalLetterInput } from '../../core/human-inbox/walnut-letters/mail-approval.js'
export type { UnsubscribeLetterInput } from '../../core/human-inbox/walnut-letters/mail-unsubscribe.js'

/**
 * The approval letter, in the user's letter language. The words and the layout live in the
 * template (core/human-inbox/walnut-letters/mail-approval.ts); this keeps the plugin's own name for it.
 */
export function renderApprovalLetter(
  input: ApprovalLetterInput,
  lang: LetterLang = 'en',
): { subject: string; markdown: string } {
  const { subject, markdown } = MAIL_APPROVAL.render(lang, input)
  return { subject, markdown }
}

/** The letter that asks whether to leave a list (template: walnut-letters/mail-unsubscribe.ts). */
export function renderUnsubscribeLetter(
  input: UnsubscribeLetterInput,
  lang: LetterLang = 'en',
): { subject: string; markdown: string } {
  const { subject, markdown } = MAIL_UNSUBSCRIBE.render(lang, input)
  return { subject, markdown }
}
