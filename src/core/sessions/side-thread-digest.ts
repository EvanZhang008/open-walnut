/**
 * Side-thread DIGEST — the summary variant of "inject to chat".
 *
 * Injecting a whole aside is right when the aside is short, and wrong when it is
 * ten turns of debugging: the main session gets a wall of text it must re-read.
 * The digest asks for a handoff paragraph instead.
 *
 * WHO writes it: the side thread's own session. It already holds the aside in
 * context (its cache is warm from the turn that just answered), so the summary
 * costs one small incremental turn and needs no second model, no extra spawn and
 * no context copy. The same reasoning the summarizer-self-report decision
 * records: the party with first-hand context writes the text.
 *
 * The REQUEST is machine plumbing, so session-history hides the tagged user
 * line — but NOT the reply. Keeping the summary visible in the drawer is the
 * point: the user reads it, and can re-run or inject the full aside instead.
 * (Contrast the cache warm-up, where both sides are hidden: nobody wants to read
 * the word "Ready".)
 */

export const SIDE_THREAD_DIGEST_TAG = '<walnut-side-thread-digest>';

/**
 * Deliberate prompt choices, each one load-bearing:
 *  · "not a user message" — otherwise a session in a working rhythm treats it as
 *    the next task and starts editing files.
 *  · plain text, no HTML — the destination is a COMPOSER, not a rendered bubble,
 *    and the thread may be in rich output mode with a standing HTML instruction
 *    from an earlier turn (this send bypasses the per-message reminder, but the
 *    standing instruction is still in its context).
 *  · no tools — a digest that reads files is a second investigation, not a summary.
 *  · keep identifiers verbatim — a handoff whose file paths and symbols have been
 *    paraphrased is useless to the session receiving it.
 */
export const SIDE_THREAD_DIGEST_MESSAGE =
  `${SIDE_THREAD_DIGEST_TAG}This is a request from the tool hosting this side thread, not a user `
  + 'message. Summarize THIS side conversation as a handoff for the main session it branched from, '
  + 'which cannot see any of it.\n\n'
  + 'Rules: lead with the conclusion; keep every file path, symbol, command and number verbatim; '
  + 'say what was ruled out when that is the useful part; end with the open question or next step '
  + 'if one is left. Under 150 words. PLAIN TEXT ONLY — no HTML, no headings, no code fences, no '
  + 'markdown tables. Use no tools and ask nothing back; reply with the summary and nothing '
  + 'else.\n\n'
  + 'Your reply MUST begin with exactly this line, on its own:\n'
  + 'Summary for the main session:\n'
  + 'The tool identifies your summary by that line and will discard a reply without '
  + `it.</walnut-side-thread-digest>`;

/**
 * The reply's required first line. This is what makes "inject summary" SAFE rather
 * than merely likely: the drawer accepts a message as the summary only when it
 * starts with this, so a read that races the transcript flush, a turn that was
 * already running, or a session that woke itself up can never have its text pasted
 * into the main chat as if it were the summary. Measured on a live session before
 * this existed: the previous ANSWER was injected, labelled as a summary.
 *
 * Readable on purpose — it stays visible in the drawer as a heading, so it costs
 * the reader nothing. The client strips it before injecting (the injected text
 * carries its own provenance header).
 */
export const SIDE_THREAD_DIGEST_REPLY_MARKER = 'Summary for the main session:';

/** Does this transcript line carry the digest REQUEST (hidden), not its reply? */
export function isSideThreadDigestText(text: string): boolean {
  return text.startsWith(SIDE_THREAD_DIGEST_TAG);
}

/**
 * Remove the digest REQUEST from a transcript user line, returning what remains.
 *
 * Not a prefix test: the CLI drains everything pending into ONE user line
 * (`msgs.map(m => m.message).join('\n\n')`), so a follow-up the user typed a
 * moment earlier can sit in front of the tag. Anchoring at index 0 there left the
 * whole machine prompt on screen forever, and anchoring on the whole line would
 * have swallowed the user's own words with it.
 */
export function stripSideThreadDigestRequest(text: string): string {
  if (!text.includes(SIDE_THREAD_DIGEST_TAG)) return text;
  return text
    .replace(/<walnut-side-thread-digest>[\s\S]*?<\/walnut-side-thread-digest>/g, '')
    .trim();
}
