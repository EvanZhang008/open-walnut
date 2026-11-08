/**
 * Claude Code's own error reply ("Prompt is too long", "API Error: ..."): a synthetic assistant
 * message the CLI marks itself (`isApiErrorMessage` in the transcript, `error` on the stream-json
 * line). Every reader of a session's lines reads it the same way, as the CLI's error line and
 * never the model's answer: the history parse (session-history.ts), the cloud's transcript tail
 * (transcript-from-jsonl.ts) and the cloud's live stream to the phone (ws/bridge-registry.ts).
 * No imports, so the light readers can take it.
 */

/** How a Claude Code error reply reads as a row: whose words they are, then its own. */
export const CLI_ERROR_PREFIX = 'Claude Code: '

type CliLine = { isApiErrorMessage?: boolean; error?: unknown; message?: { model?: string } }

/** Claude Code's own error reply: its transcript marks it, its stream-json output names the error on its synthetic message. */
export function isCliErrorReply(raw: CliLine): boolean {
  return raw.isApiErrorMessage === true || (typeof raw.error === 'string' && raw.message?.model === '<synthetic>')
}

/** The reply's words as its row reads them ("Claude Code: Prompt is too long"), or null when the line is no such reply or says nothing. */
export function cliErrorRowText(raw: CliLine & { message?: { content?: unknown } }): string | null {
  if (!isCliErrorReply(raw)) return null
  const content = raw.message?.content
  const text = typeof content === 'string' ? content.trim()
    : Array.isArray(content)
      ? content.flatMap((b) => {
        const block = b as { type?: string; text?: unknown }
        return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
      }).join('\n').trim()
      : ''
  return text ? `${CLI_ERROR_PREFIX}${text}` : null
}

/**
 * Text that is Claude Code's own error or status line, read by its words alone, for a reader that
 * got only text (a side question's answer, a `claude -p` result): "Not logged in · Please run
 * /login", "Invalid API key", "API Error: 529 ...", "Prompt is too long", a usage limit. Short
 * text only, anchored at its start, so a real answer that DISCUSSES a login error is not one.
 */
// Only the CLI's own phrasings: a title like "Rate limit backoff" or "Error 500 on login" is a title.
const CLI_ERROR_TEXT_RE = /^(?:claude code:\s*)?(?:not logged in\b|please run \/login|invalid api key|failed to authenticate|authentication_error|oauth (?:access )?token (?:has )?expired|api error:|credit balance is too low|prompt is too long|claude ai usage limit|usage limit reached|execution error|no conversation found with session)/i

export function isCliErrorText(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && t.length < 300 && (CLI_ERROR_TEXT_RE.test(t) || /·\s*please run \/login/i.test(t))
}
