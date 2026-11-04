/**
 * The prompt cache facts a session panel reads from its loaded history when its
 * record has none, and the token count the "+" menu row shows. (The cold-cache
 * offer that lived here is gone: once the cache expired Walnut neither compacts
 * nor says anything, CompactContext.tsx.)
 */
import { noteCompaction, noteRequestUsage, type ClaudeUsageLike, type PromptCacheFacts } from '../../../../src/core/sessions/prompt-cache';

/** 412000 → "412K", 1250000 → "1.3M". */
export function formatContextTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
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
 * reply's, a little after the request.
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
