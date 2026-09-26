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

/**
 * Put a slash command at the start of the composer text.
 *
 * A "+" menu row that arms a skill cannot insert at the caret the way `@` does:
 * text the user already typed becomes the command's argument instead. Choosing
 * the row twice leaves the text alone. The caret lands at the end, where the
 * user keeps typing what the command is about.
 */
export function withLeadingCommand(value: string, command: string): { value: string; caret: number } {
  const rest = value.replace(/^\s+/, '');
  const after = rest.slice(command.length);
  if (rest.startsWith(command) && /^\s/.test(after)) {
    if (after.startsWith(' ')) return { value, caret: value.length };
    // Already there but followed by a newline or tab: add the space the CLI splits on.
    const next = `${command} ${after}`;
    return { value: next, caret: next.length };
  }
  const next = rest && rest !== command ? `${command} ${rest}` : `${command} `;
  return { value: next, caret: next.length };
}
