/**
 * The browser's twin of src/core/sessions/context-full.ts isContextFullText: a turn
 * error that says the conversation no longer fits the model's context window
 * ("Prompt is too long"). tests/core/sessions/context-full.test.ts keeps the two alike.
 */
const CONTEXT_FULL_PATTERNS: readonly RegExp[] = [
  /\bprompt is too long\b/i,
  /\binput is too long for (the )?requested model\b/i,
];

export function isContextFullText(text: string | null | undefined): boolean {
  if (!text || text.length > 600) return false;
  return CONTEXT_FULL_PATTERNS.some((re) => re.test(text));
}

/**
 * Whether a session's error is one Compact and resend answers: the error says the context is full,
 * or Walnut's recovery failed on it (its compaction met a 529 or a network error, which then is the
 * error shown). Twin of src/core/sessions/context-full.ts needsContextRecovery.
 */
export function needsContextRecovery(rec: {
  process_status?: string; errorMessage?: string | null; contextRecovery?: { state?: string } | null;
  lane?: string | null; provider?: string | null; engine?: string | null;
} | null | undefined): boolean {
  if (!rec) return false;
  // Only a Claude Code session is compacted and resent; an ACP engine's error keeps the plain banner.
  if (rec.lane || rec.provider === 'embedded' || (rec.engine && rec.engine !== 'claude')) return false;
  const failed = rec.contextRecovery?.state === 'failed';
  if (rec.process_status === 'stopped') return failed;
  if (rec.process_status !== 'error') return false;
  return isContextFullText(rec.errorMessage) || failed;
}
