/**
 * When may the "History unavailable" card be shown?
 *
 * It is a LAST-RESORT state and only means anything when there is genuinely
 * nothing else to render. A session that is streaming, or that already has
 * persisted rows / optimistic bubbles on screen, actively CONTRADICTS the claim
 * "history is unavailable" — painting the card above real content is how the user
 * ended up looking at a Running session with visible system messages under a
 * "Session history file not found" box.
 *
 * The server no longer sends that reason during a session's startup window
 * (core/sessions/session-lifecycle.ts → isHistoryStartupWindow), so this is the
 * client-side backstop for the same family: any unavailable answer that arrives —
 * or lingers in state — while content exists is suppressed.
 */

/** Extract the human-readable reason from the hook's error string, else null. */
export function parseHistoryUnavailable(error: string | null | undefined): string | null {
  const PREFIX = 'HISTORY_UNAVAILABLE:';
  return error?.startsWith(PREFIX) ? error.slice(PREFIX.length) : null;
}

/**
 * The reason to render, or null to stay silent.
 * `hasContent` = messages / timeline / streaming / optimistic bubbles — anything
 * visible in the transcript area.
 */
export function visibleHistoryUnavailable(
  error: string | null | undefined,
  hasContent: boolean,
): string | null {
  if (hasContent) return null;
  return parseHistoryUnavailable(error);
}
