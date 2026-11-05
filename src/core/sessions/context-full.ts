/**
 * A Claude Code session whose conversation no longer fits its context window
 * (2026-11-05: a session on a host with Claude Code's auto-compact switched off
 * reached 176K of a 200K window, and from then on the CLI answered every
 * message, the user's "hi" included, with "Prompt is too long" before calling
 * the model; the banner offered only Reconnect).
 *
 * Claude Code says it in one sentence (`PROMPT_TOO_LONG_ERROR_MESSAGE`), whether
 * its own pre-flight check refused the request (auto-compact off: it stops at
 * the blocking limit below) or the API answered a 400 "prompt is too long".
 * Bedrock's own wording is matched too, for an engine that passes it through.
 *
 * The limits mirror the CLI (services/compact/autoCompact.ts, 2.1.3xx): it
 * reserves up to 20K tokens for the summary's output, auto-compacts 13K below
 * what is left, and with auto-compact off refuses every request 3K below it.
 */

import { isAcpEngine } from '../agents/engine-registry.js';

const CONTEXT_FULL_PATTERNS: readonly RegExp[] = [
  /\bprompt is too long\b/i,
  /\binput is too long for (the )?requested model\b/i,
];

/** True when a turn's error text says the conversation no longer fits the model's window. */
export function isContextFullText(text: string | null | undefined): boolean {
  if (!text) return false;
  // A result whose whole text is a model's reply that merely quotes the phrase is no failure:
  // only short error texts are judged (the CLI's own is 18 characters, an API body a few hundred).
  if (text.length > 600) return false;
  return CONTEXT_FULL_PATTERNS.some((re) => re.test(text));
}

/**
 * Whether a session's error is one Compact and resend answers: the error says the context is full,
 * or Walnut's recovery failed on it (2026-11-05 review: its compaction met a 529, which then was the
 * error shown, and the banner offered Reconnect again). A clean turn settles the failed state
 * (context-full-recovery.ts), so a later unrelated error is not read as this one.
 */
export function needsContextRecovery(rec: {
  process_status?: string; errorMessage?: string | null; contextRecovery?: { state?: string } | null;
  lane?: string | null; provider?: string | null; engine?: string | null;
} | null | undefined): boolean {
  if (!rec) return false;
  // Only a Claude Code session is compacted and resent (context-full-recovery.ts notRecoverable).
  if (rec.lane || rec.provider === 'embedded' || isAcpEngine(rec.engine)) return false;
  const failed = rec.contextRecovery?.state === 'failed';
  // A restart or a Stop can leave a failed recovery on a stopped session: Retry compacts it too.
  if (rec.process_status === 'stopped') return failed;
  if (rec.process_status !== 'error') return false;
  return isContextFullText(rec.errorMessage) || failed;
}

/** What Claude Code holds back of the window for a compaction summary's output. */
export const SUMMARY_OUTPUT_RESERVE_TOKENS = 20_000;
/** How far below the usable window the CLI refuses every request when auto-compact is off. */
export const BLOCKING_BUFFER_TOKENS = 3_000;

/**
 * Where a session whose auto-compact is off stops: Claude Code refuses every
 * request at or above this many tokens. `window` is the window the CLI
 * compacts against (the model's, or a CLAUDE_CODE_AUTO_COMPACT_WINDOW below it).
 */
export function hardStopTokens(window: number, maxOutputTokens?: number): number {
  // The CLI reserves min(the model's max output, 20K); an output cap below 20K (CLAUDE_CODE_MAX_OUTPUT_TOKENS) shrinks it.
  const reserve = maxOutputTokens && maxOutputTokens > 0 ? Math.min(maxOutputTokens, SUMMARY_OUTPUT_RESERVE_TOKENS) : SUMMARY_OUTPUT_RESERVE_TOKENS;
  return Math.max(0, window - reserve - BLOCKING_BUFFER_TOKENS);
}
