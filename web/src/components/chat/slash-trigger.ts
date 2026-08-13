/**
 * Detect an active "/" slash command at the caret.
 *
 * Mirrors the "@" mention trigger (detectMention in ChatInput): fires when the
 * "/" sits at the start of the input or right after whitespace — so paths like
 * `src/foo.ts` and URLs (`https://…`) don't false-fire — and the caret is still
 * inside the command name: no whitespace and no further "/" between the "/" and
 * the caret (a second "/" means the user is typing a path like `/Users/me`,
 * not a command).
 *
 * Returns the "/" index and the query typed after it, or null when no slash
 * command is active at the caret.
 */
export function detectSlashCommand(
  text: string,
  caret: number,
): { slashIndex: number; query: string } | null {
  // caret 0 = nothing typed left of the caret (lastIndexOf would clamp -1 → 0
  // and falsely match a "/" the caret sits BEFORE).
  if (caret <= 0) return null;
  const slash = text.lastIndexOf('/', caret - 1);
  if (slash === -1) return null;
  const before = slash === 0 ? '' : text[slash - 1];
  if (before && !/\s/.test(before)) return null;
  const query = text.slice(slash + 1, caret);
  if (/[\s/]/.test(query)) return null;
  return { slashIndex: slash, query };
}
