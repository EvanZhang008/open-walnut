/**
 * Shared helper: build the prompt text that the Changed-view's "Ask about this"
 * selection drops into the EXISTING session chat input (via ChatInput's
 * prefillText/prefillNonce). SessionPanel uses this so
 * the prefill reads identically in the two places sessions render.
 *
 * The message names the file + line and quotes the selected code, then leaves the
 * cursor after a colon so the user just types their question and hits Send — the
 * message goes to the MAIN agent through the normal send path (no fork, no btw).
 */
/**
 * Shorten an absolute path to be cwd-relative when it lives under the session's
 * working directory.
 *
 * The Changed tab already hands `buildSelectionPrefill` a repo-relative path (its
 * own displayPath does this), but the Files tab browses the whole filesystem and
 * only has absolutes. Passing those through verbatim produced quotes headed by a
 * 90-character path for a file the agent thinks of as `src/x.ts`. Anything OUTSIDE
 * the cwd keeps its absolute path — there it's information, not noise.
 */
export function displayPathForPrefill(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const base = cwd.replace(/\/+$/, '');
  if (!base || !filePath.startsWith(base + '/')) return filePath;
  return filePath.slice(base.length + 1);
}

export function buildSelectionPrefill(filePath: string, line: number | undefined, code: string): string {
  const loc = line != null ? `${filePath}:${line}` : filePath;
  const trimmed = code.trim();
  // Multi-line selection → fenced block; single line → inline backticks.
  const quoted = trimmed.includes('\n')
    ? `\n\`\`\`\n${trimmed}\n\`\`\`\n`
    : `\`${trimmed}\``;
  return `About ${loc} ${quoted}: `;
}

/**
 * Compose the message a GitHub-style LINE COMMENT sends to the main agent:
 * a located header + the line's code quoted + the user's note. Unlike the
 * "Ask about this" prefill (which only fills the input), a line comment is sent
 * straight through the normal send path, so this returns the FINAL message text.
 *
 * Mirrors buildSelectionPrefill's quoting so a located reference reads the same
 * whether the user selected text (prefill) or clicked a line and typed (comment).
 *   - loc:     "src/x.ts:L10" or "src/x.ts:L10-L14"
 *   - code:    the anchored line(s) text (quoted; empty code → no quote)
 *   - comment: the user's note (always present — callers gate on non-empty)
 */
export function buildCommentMessage(loc: string, code: string, comment: string): string {
  const trimmed = code.trim();
  const quoted = trimmed
    ? (trimmed.includes('\n') ? `\n\`\`\`\n${trimmed}\n\`\`\`\n` : ` \`${trimmed}\``)
    : '';
  return `Re: ${loc}${quoted}\n\n${comment}`;
}

/** One recorded review comment, before composition. */
export interface ReviewComment {
  loc: string;
  code: string;
  comment: string;
}

/**
 * Compose a whole BATCH of recorded comments into a single review message — the
 * GitHub "submit review" model, where the user leaves many line comments and
 * sends them together at the end (vs. "Send now", which fires one immediately).
 *
 * A single comment degrades to the exact same text buildCommentMessage produces,
 * so a 1-comment review reads identically whether sent now or submitted. Multiple
 * comments become a numbered list under a count header. The SAME text is what the
 * "Copy" button copies, so what the user pastes elsewhere matches what we send.
 */
export function buildReviewMessage(comments: ReviewComment[]): string {
  if (comments.length === 0) return '';
  if (comments.length === 1) {
    const c = comments[0]!;
    return buildCommentMessage(c.loc, c.code, c.comment);
  }
  const blocks = comments.map((c, i) => {
    const trimmed = c.code.trim();
    const quoted = trimmed
      ? (trimmed.includes('\n') ? `\n\`\`\`\n${trimmed}\n\`\`\`` : ` \`${trimmed}\``)
      : '';
    return `${i + 1}. Re: ${c.loc}${quoted}\n${c.comment}`;
  });
  return `Code review — ${comments.length} comments:\n\n${blocks.join('\n\n')}`;
}

/**
 * The transcript's "Quote" / "Comment" (the selection pill): the passage as a
 * Markdown quote for the main conversation's next message, then the user's comment
 * under it when there is one, then a blank line for what comes next. Each line
 * quoted, so a multi-paragraph passage stays one quote; trailing spaces go, since
 * they would only end up inside the quote.
 */
export function buildPassagePrefill(passage: string, comment?: string): string {
  const lines = passage.replace(/\r\n?/g, '\n').trim().split('\n').map((l) => l.trimEnd());
  const quote = `${lines.map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n`;
  const note = comment?.replace(/\r\n?/g, '\n').trim();
  return note ? `${quote}${note}\n\n` : quote;
}

/**
 * The block a terminal selection's "Add to chat" puts in the composer: where it
 * came from, then the output as it was printed, in a fence (a longer one when
 * the output itself holds a fence). Trailing spaces and blank edge lines go: a
 * terminal pads rows with spaces.
 */
export function buildTerminalPrefill(output: string, source: string): string {
  const lines = output.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.join('\n');
  let fence = '```';
  while (body.includes(fence)) fence += '`';
  return `From ${source}:\n${fence}text\n${body}\n${fence}\n`;
}
