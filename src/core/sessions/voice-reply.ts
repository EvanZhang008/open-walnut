/**
 * Voice reply: the line a send carries when the person is TALKING to the session
 * (the phone's voice mode) and will hear the answer read aloud instead of reading it.
 *
 * Same carrier as the output-mode reminder (output-mode.ts): one machine line after
 * the human's words, on every voice send, stripped from every display surface by
 * `stripOutputModeWrappers` (the history projection's choke point). It rides every
 * voice send rather than once per mode change because a voice conversation is turn
 * by turn: the person may type the next message, and a typed message must get an
 * ordinary answer.
 *
 * The wording asks for the spoken answer FIRST and puts any detail under a `---`
 * line, because the phone reads aloud only what comes before that line
 * (ios-native SpokenText). Detail after it stays on screen. A reply that ignores
 * the shape still works: the phone then reads a trimmed opening of the message.
 *
 * The one clause about handing work to another task is what makes "tell me when it
 * is done" work for the Walnut agent: a reply request is what wakes it when the
 * other task finishes (session-request-watch), and that wake is a new turn the
 * phone reads aloud too.
 */

/** Opening literal; the strippers match lines that start with it and end with `]`. */
export const VOICE_REPLY_MARKER = '[Voice reply: ';

/** One line, no `]` before the last character (the strippers key on the closing bracket). */
export const VOICE_REPLY_INSTRUCTION =
  `${VOICE_REPLY_MARKER}the user is talking to you by voice and will hear your final message read aloud. `
  + 'Do the work as usual. Begin your final message with a short spoken answer: two to four plain sentences '
  + 'in the language they spoke, saying what you did or found and what you need from them next. '
  + 'No markdown, code, tables, links or file paths in that answer. '
  + 'Put any detail after it, below a line that holds only ---. '
  + 'When you hand work to another task, ask it for a reply so you can tell them when it is done. '
  + 'This overrides the output style for this reply.]';

/**
 * Append the voice line after the text the CLI will receive. A slash command is
 * left byte-exact: the CLI treats input as a command only when the raw string
 * starts with '/', and an appended line would ride into the command's arguments.
 */
export function applyVoiceReply(message: string): string {
  if (message.startsWith('/')) return message;
  return `${message}\n\n${VOICE_REPLY_INSTRUCTION}`;
}

/** Is this whole line the voice instruction? Line-anchored, like the output-mode lines. */
export function isVoiceReplyLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith(VOICE_REPLY_MARKER) && t.endsWith(']');
}
