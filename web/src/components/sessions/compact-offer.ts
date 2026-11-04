/**
 * When a session panel offers to compact first: a big Claude Code session whose
 * prompt cache has expired, so the next message would re-read the whole context
 * at full price. Pure, so the rule is tested without a browser.
 */
import {
  cacheExpiresAtMs, DEFAULT_IDLE_COMPACT_MIN_TOKENS, noteCompaction, noteRequestUsage, type ClaudeUsageLike, type PromptCacheFacts,
} from '../../../../src/core/sessions/prompt-cache';

export interface CompactOfferInput {
  facts: PromptCacheFacts | undefined;
  /** An ACP engine has no /compact of Claude Code's. */
  acp: boolean;
  /** A chat lane is the Personal AI's own conversation. */
  lane?: string;
  /** A turn runs: its next request refreshes the cache anyway. */
  running: boolean;
  /** The requestAt the user said "not now" to. */
  dismissedFor?: string | null;
  minTokens?: number;
  nowMs: number;
}

export interface CompactOffer {
  tokens: number;
  /** How long ago the cache expired, ms. */
  expiredForMs: number;
  /** The request it is about (what a dismissal keys on). */
  requestAt: string;
}

export function compactOffer(input: CompactOfferInput): CompactOffer | null {
  const { facts } = input;
  if (!facts || input.acp || input.lane || input.running || facts.compactedAt) return null;
  if (facts.tokens < (input.minTokens ?? DEFAULT_IDLE_COMPACT_MIN_TOKENS)) return null;
  if (input.dismissedFor === facts.requestAt) return null;
  const expiresAt = cacheExpiresAtMs(facts);
  if (!Number.isFinite(expiresAt) || input.nowMs < expiresAt) return null;
  return { tokens: facts.tokens, expiredForMs: input.nowMs - expiresAt, requestAt: facts.requestAt };
}

/** When the offer would appear for these facts (to wake a timer), or null when it never will. */
export function compactOfferDueAt(facts: PromptCacheFacts | undefined, minTokens = DEFAULT_IDLE_COMPACT_MIN_TOKENS): number | null {
  if (!facts || facts.compactedAt || facts.tokens < minTokens) return null;
  const at = cacheExpiresAtMs(facts);
  return Number.isFinite(at) ? at : null;
}

/** 412000 → "412K", 1250000 → "1.3M". */
export function formatContextTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** "3 min", "1 hour", "4 days": how long ago the cache went cold. */
export function formatAgo(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return h === 1 ? '1 hour' : `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/** The history rows the fallback reads: an assistant reply with its usage, or a compaction row. */
export interface HistoryRowLike {
  role: string;
  timestamp?: string;
  usage?: unknown;
  systemVariant?: string;
}

/**
 * The facts of a session that has none stored (its last turn ran before Walnut kept them): from
 * the last assistant reply's usage and time, unless a compaction came after it. Its time is the
 * reply's, a little after the request, so the offer comes at most that much late.
 */
export function factsFromHistory(rows: readonly HistoryRowLike[]): PromptCacheFacts | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const at = Date.parse(row.timestamp ?? '');
    if (row.role === 'system' && row.systemVariant === 'compact') {
      return Number.isFinite(at) ? noteCompaction(undefined, 0, at) : undefined;
    }
    if (row.role === 'assistant' && row.usage && typeof row.usage === 'object' && Number.isFinite(at)) {
      return noteRequestUsage(undefined, row.usage as ClaudeUsageLike, at, true);
    }
  }
  return undefined;
}
