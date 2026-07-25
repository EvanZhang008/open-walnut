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
