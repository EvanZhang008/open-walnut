/**
 * Slash commands at the start of a message.
 *
 * An engine reads `/name` as a command only when the message starts with it, and
 * the Claude CLI splits the command from its arguments on the first SPACE (a
 * newline right after the name becomes part of the name). So a command the user
 * put first has to stay first, followed by a space, whatever else the composer
 * adds to the message (reference tags, a quoted passage).
 */

/** `/name` as the very first word: followed by a space or by nothing. */
const LEADING_COMMAND = /^\/[A-Za-z0-9][\w:.-]*(?= |$)/;

/** The leading command of `text` and what follows it, or null when it has none. */
export function splitLeadingCommand(text: string): { command: string; rest: string } | null {
  const m = LEADING_COMMAND.exec(text);
  if (!m) return null;
  return { command: m[0], rest: text.slice(m[0].length).replace(/^ /, '') };
}

/**
 * Add what the composer puts in front of a message (a quoted passage, a "Back to
 * the earlier thread" line) without pushing a leading command off the first word:
 * the addition goes into the command's arguments instead. `compose` adds it to
 * plain text; a message it leaves alone is sent exactly as typed.
 */
export function keepCommandFirst(message: string, compose: (text: string) => string): string {
  const lead = splitLeadingCommand(message);
  if (!lead) return compose(message);
  const composed = compose(lead.rest);
  return composed === lead.rest ? message : `${lead.command} \n${composed}`;
}
