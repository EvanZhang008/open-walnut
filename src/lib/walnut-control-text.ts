/**
 * An agent's words without Walnut's control markup.
 *
 * A turn can carry lines meant for Walnut, not for a person: the turn marker
 * (`<walnut-turn status="agent-ack"/>`), an echoed notice (`<walnut-message ...>...</walnut-message>`),
 * a hint block, a system reminder. Anything that reads an agent's message as prose for a person
 * (a status line's last words, an approval's reason, a summary's input) reads it through here
 * first, so a control line never becomes the reason a person reads (2026-11-14: an approval's
 * "why" was `<walnut-turn status="agent-ack"/>`). Ratchet: tests/lib/walnut-control-text.test.ts
 * fails on a new regex for these tags anywhere else in src/.
 *
 * Zero imports: the CLI, the server and the daemon twins may all load it.
 */

/** A whole Walnut block: `<walnut-x ...>...</walnut-x>`, the same name closing it. */
const WALNUT_BLOCK_RE = /<(walnut-[a-z0-9-]+)\b[^>]*>[\s\S]*?<\/\1>/gi
/** A self-closing Walnut tag, the turn marker among them: `<walnut-x .../>`. */
const WALNUT_SELF_CLOSING_RE = /<walnut-[a-z0-9-]+\b[^>]*\/>/gi
/** A stray opening or closing Walnut tag left without its pair. */
const WALNUT_STRAY_TAG_RE = /<\/?walnut-[a-z0-9-]+\b[^>]*>/gi
/** A harness reminder that rode in the text. */
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

/** The text with every Walnut control tag and block removed (whitespace kept as it was). Pure. */
export function withoutWalnutControl(text: string): string {
  if (!text || (!text.includes('<walnut-') && !text.includes('</walnut-') && !text.includes('<system-reminder>'))) return text ?? ''
  return text
    .replace(SYSTEM_REMINDER_RE, ' ')
    .replace(WALNUT_BLOCK_RE, ' ')
    .replace(WALNUT_SELF_CLOSING_RE, ' ')
    .replace(WALNUT_STRAY_TAG_RE, ' ')
}

/** Whether any words are left for a person once the control markup is gone. Pure. */
export function hasWordsBeyondControl(text: string): boolean {
  return withoutWalnutControl(text).trim() !== ''
}
